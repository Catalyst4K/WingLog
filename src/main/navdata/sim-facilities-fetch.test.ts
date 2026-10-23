import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FacilityDataType, RawBuffer, type SimConnectConnection } from 'node-simconnect'
import { NavdataDefId } from '../sim/facility-fields'
import { fetchAirportNavdata, fetchTaxiNetwork } from './sim-facilities-fetch'

function buffer(write: (b: RawBuffer) => void): RawBuffer {
  const b = new RawBuffer(0)
  write(b)
  b.setOffset(0)
  return b
}

function airportBuffer(icao: string): RawBuffer {
  return buffer((w) => w.writeString8(icao))
}

function runwayBuffer(): RawBuffer {
  return buffer((w) => {
    w.writeFloat64(51.4775)
    w.writeFloat64(-0.4614)
    w.writeFloat32(270)
    w.writeFloat32(3902)
    w.writeFloat32(50)
    w.writeInt32(2)
    w.writeInt32(27)
    w.writeInt32(0)
    w.writeInt32(9)
    w.writeInt32(0)
  })
}

function procedureBuffer(name: string): RawBuffer {
  return buffer((w) => {
    w.writeString8(name)
    w.writeInt32(1)
    w.writeInt32(1)
    w.writeInt32(1)
  })
}

function runwayTransitionBuffer(number: number, designator: number): RawBuffer {
  return buffer((w) => {
    w.writeInt32(number)
    w.writeInt32(designator)
    w.writeInt32(0)
  })
}

function enrouteTransitionBuffer(name: string): RawBuffer {
  return buffer((w) => {
    w.writeString8(name)
    w.writeInt32(0)
  })
}

function approachBuffer(
  type: number,
  suffixCode: number,
  runwayNumber: number,
  runwayDesignator: number
): RawBuffer {
  return buffer((w) => {
    w.writeInt32(type)
    w.writeInt32(suffixCode)
    w.writeInt32(runwayNumber)
    w.writeInt32(runwayDesignator)
    w.writeInt32(1)
    w.writeInt32(1)
    w.writeInt32(1)
  })
}

function legBuffer(fixIcao: string): RawBuffer {
  return buffer((w) => {
    w.writeInt32(4)
    w.writeString8(fixIcao)
    w.writeInt32(87)
    w.writeFloat64(51.5)
    w.writeFloat64(-0.2)
    w.writeInt32(0)
    w.writeFloat32(270)
    w.writeFloat32(6000)
    w.writeFloat32(4000)
    w.writeFloat32(250)
  })
}

/** Minimal stand-in for SimConnectConnection — a real EventEmitter (so `.on`/
 *  `.removeListener`/`.emit` behave exactly as the fetch code expects) plus spies for the
 *  two outbound methods it calls. No real SimConnect wire format involved; only the
 *  envelope fields the fetch code actually reads (type/userRequestId/uniqueRequestId/
 *  parentUniqueRequestId/data) need to be present on an emitted event. */
class FakeHandle extends EventEmitter {
  addToFacilityDefinition = vi.fn()
  requestFacilityData = vi.fn()
  addFacilityDataDefinitionFilter = vi.fn()
}

function endAll(handle: FakeHandle): void {
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.RUNWAYS })
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.DEPARTURES })
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.ARRIVALS })
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.APPROACHES })
}

describe('fetchAirportNavdata', () => {
  it('resolves with runways and procedures once all three requests end, reassembling parent/child links', async () => {
    const handle = new FakeHandle()
    const promise = fetchAirportNavdata(handle as unknown as SimConnectConnection, 'EGLL')

    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.RUNWAYS,
      uniqueRequestId: 1,
      parentUniqueRequestId: 0,
      data: airportBuffer('EGLL')
    })
    handle.emit('facilityData', {
      type: FacilityDataType.RUNWAY,
      userRequestId: NavdataDefId.RUNWAYS,
      uniqueRequestId: 2,
      parentUniqueRequestId: 1,
      data: runwayBuffer()
    })

    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.DEPARTURES,
      uniqueRequestId: 10,
      parentUniqueRequestId: 0,
      data: airportBuffer('EGLL')
    })
    handle.emit('facilityData', {
      type: FacilityDataType.DEPARTURE,
      userRequestId: NavdataDefId.DEPARTURES,
      uniqueRequestId: 11,
      parentUniqueRequestId: 10,
      data: procedureBuffer('BPK7F')
    })
    handle.emit('facilityData', {
      type: FacilityDataType.RUNWAY_TRANSITION,
      userRequestId: NavdataDefId.DEPARTURES,
      uniqueRequestId: 12,
      parentUniqueRequestId: 11,
      data: runwayTransitionBuffer(9, 0)
    })
    // Nested inside the runway transition (parent 12), not the procedure (11) — this is
    // where a real SID's legs actually live (docs/navdata-notes.md).
    handle.emit('facilityData', {
      type: FacilityDataType.APPROACH_LEG,
      userRequestId: NavdataDefId.DEPARTURES,
      uniqueRequestId: 15,
      parentUniqueRequestId: 12,
      data: legBuffer('RWYFIX')
    })
    handle.emit('facilityData', {
      type: FacilityDataType.ENROUTE_TRANSITION,
      userRequestId: NavdataDefId.DEPARTURES,
      uniqueRequestId: 13,
      parentUniqueRequestId: 11,
      data: enrouteTransitionBuffer('CLEEE')
    })
    // Nested inside the enroute transition (parent 13).
    handle.emit('facilityData', {
      type: FacilityDataType.APPROACH_LEG,
      userRequestId: NavdataDefId.DEPARTURES,
      uniqueRequestId: 16,
      parentUniqueRequestId: 13,
      data: legBuffer('ENRFIX')
    })
    // Parented directly to the procedure (11) — a common leg, outside any transition.
    handle.emit('facilityData', {
      type: FacilityDataType.APPROACH_LEG,
      userRequestId: NavdataDefId.DEPARTURES,
      uniqueRequestId: 14,
      parentUniqueRequestId: 11,
      data: legBuffer('BPK')
    })

    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.ARRIVALS,
      uniqueRequestId: 20,
      parentUniqueRequestId: 0,
      data: airportBuffer('EGLL')
    })

    endAll(handle)

    const result = await promise
    expect(result.icao).toBe('EGLL')
    expect(result.runways).toHaveLength(1)
    expect(result.runways[0]!.primaryIdent).toBe('27')
    expect(result.arrivals).toEqual([])
    expect(result.departures).toHaveLength(1)
    const departure = result.departures[0]!
    expect(departure.name).toBe('BPK7F')
    expect(departure.commonLegs).toHaveLength(1)
    expect(departure.commonLegs[0]).toMatchObject({ fixIdent: 'BPK', fixType: 'W' })
    expect(departure.runwayTransitions).toEqual([
      { runwayIdent: '09', legs: [expect.objectContaining({ fixIdent: 'RWYFIX' })] }
    ])
    expect(departure.enrouteTransitions).toEqual([
      { name: 'CLEEE', legs: [expect.objectContaining({ fixIdent: 'ENRFIX' })] }
    ])
  })

  it("reassembles an approach's transition legs and final segment, real VHHH RNP-Z-07R shape", async () => {
    const handle = new FakeHandle()
    const promise = fetchAirportNavdata(handle as unknown as SimConnectConnection, 'VHHH')

    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.APPROACHES,
      uniqueRequestId: 30,
      parentUniqueRequestId: 0,
      data: airportBuffer('VHHH')
    })
    // type=10 (RNAV/RNP), suffixCode=90 ('Z'), runway 07R — real values captured live
    // (docs/navdata-notes.md).
    handle.emit('facilityData', {
      type: FacilityDataType.APPROACH,
      userRequestId: NavdataDefId.APPROACHES,
      uniqueRequestId: 31,
      parentUniqueRequestId: 30,
      data: approachBuffer(10, 90, 7, 2)
    })
    handle.emit('facilityData', {
      type: FacilityDataType.APPROACH_TRANSITION,
      userRequestId: NavdataDefId.APPROACHES,
      uniqueRequestId: 32,
      parentUniqueRequestId: 31,
      data: enrouteTransitionBuffer('LIMES')
    })
    // Nested inside the transition (parent 32) — the real STAR-handoff/IAF legs.
    handle.emit('facilityData', {
      type: FacilityDataType.APPROACH_LEG,
      userRequestId: NavdataDefId.APPROACHES,
      uniqueRequestId: 33,
      parentUniqueRequestId: 32,
      data: legBuffer('LIMES')
    })
    handle.emit('facilityData', {
      type: FacilityDataType.APPROACH_LEG,
      userRequestId: NavdataDefId.APPROACHES,
      uniqueRequestId: 34,
      parentUniqueRequestId: 32,
      data: legBuffer('VH720')
    })
    // Parented directly to the approach (31), not the transition — the shared final segment.
    handle.emit('facilityData', {
      type: FacilityDataType.FINAL_APPROACH_LEG,
      userRequestId: NavdataDefId.APPROACHES,
      uniqueRequestId: 35,
      parentUniqueRequestId: 31,
      data: legBuffer('VH720')
    })
    handle.emit('facilityData', {
      type: FacilityDataType.FINAL_APPROACH_LEG,
      userRequestId: NavdataDefId.APPROACHES,
      uniqueRequestId: 36,
      parentUniqueRequestId: 31,
      data: legBuffer('RW07R')
    })

    endAll(handle)

    const result = await promise
    expect(result.approaches).toHaveLength(1)
    const approach = result.approaches[0]!
    expect(approach.identifier).toBe('RNAV Z 07R')
    expect(approach.runwayIdent).toBe('07R')
    expect(approach.transitions).toEqual([
      {
        name: 'LIMES',
        legs: [expect.objectContaining({ fixIdent: 'LIMES' }), expect.objectContaining({ fixIdent: 'VH720' })]
      }
    ])
    expect(approach.finalLegs.map((l) => l.fixIdent)).toEqual(['VH720', 'RW07R'])
  })

  it('registers the facility definitions and issues one request per definition, request id == definition id', async () => {
    const handle = new FakeHandle()
    const promise = fetchAirportNavdata(handle as unknown as SimConnectConnection, 'VHHH')

    expect(handle.requestFacilityData).toHaveBeenCalledWith(
      NavdataDefId.RUNWAYS,
      NavdataDefId.RUNWAYS,
      'VHHH'
    )
    expect(handle.requestFacilityData).toHaveBeenCalledWith(
      NavdataDefId.DEPARTURES,
      NavdataDefId.DEPARTURES,
      'VHHH'
    )
    expect(handle.requestFacilityData).toHaveBeenCalledWith(
      NavdataDefId.ARRIVALS,
      NavdataDefId.ARRIVALS,
      'VHHH'
    )
    expect(handle.requestFacilityData).toHaveBeenCalledWith(
      NavdataDefId.APPROACHES,
      NavdataDefId.APPROACHES,
      'VHHH'
    )
    expect(handle.addToFacilityDefinition).toHaveBeenCalled()

    // Settle the promise (clearing its pending 20s timeout) rather than leaving it dangling
    // — an unresolved fetch would otherwise keep a real timer alive past this test.
    handle.emit('exception', { exceptionName: 'ERROR', index: 0, sendId: 1 })
    await expect(promise).rejects.toThrow()
  })

  it('rejects on a SimConnect exception rather than hanging forever', async () => {
    const handle = new FakeHandle()
    const promise = fetchAirportNavdata(handle as unknown as SimConnectConnection, 'ZZZZ')
    handle.emit('exception', { exceptionName: 'ERROR', index: 0, sendId: 1 })
    await expect(promise).rejects.toThrow(/ZZZZ/)
  })

  it('retries with a region on an ambiguous ICAO, then resolves once that retry completes', async () => {
    const handle = new FakeHandle()
    const promise = fetchAirportNavdata(handle as unknown as SimConnectConnection, 'ABCD')

    handle.emit('facilityMinimalList', {
      requestID: NavdataDefId.RUNWAYS,
      data: [{ icao: { region: 'K1' } }]
    })
    expect(handle.requestFacilityData).toHaveBeenCalledWith(
      NavdataDefId.RUNWAYS,
      NavdataDefId.RUNWAYS,
      'ABCD',
      'K1'
    )

    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.RUNWAYS,
      uniqueRequestId: 1,
      parentUniqueRequestId: 0,
      data: airportBuffer('ABCD')
    })
    endAll(handle)

    const result = await promise
    expect(result.runways).toEqual([])
  })
})

function airportLatLonBuffer(icao: string, latitude: number, longitude: number): RawBuffer {
  return buffer((w) => {
    w.writeString8(icao)
    w.writeFloat64(latitude)
    w.writeFloat64(longitude)
  })
}

function taxiPointBuffer(biasX: number, biasZ: number, type = 1): RawBuffer {
  return buffer((w) => {
    w.writeInt32(type)
    w.writeFloat32(biasX)
    w.writeFloat32(biasZ)
  })
}

function taxiPathBuffer(
  type: number,
  start: number,
  end: number,
  nameIndex: number,
  runway: [number, number] = [0, 0]
): RawBuffer {
  return buffer((w) => {
    w.writeInt32(type)
    w.writeFloat32(23)
    w.writeUint32(0)
    w.writeInt32(runway[0])
    w.writeInt32(runway[1])
    w.writeInt32(start)
    w.writeInt32(end)
    w.writeUint32(nameIndex)
  })
}

function taxiNameBuffer(name: string): RawBuffer {
  return buffer((w) => w.writeString32(name))
}

/** Real VHHH values from the TAXI_PARKING spike: the airport reference point and stand N32 (GATE_N = 25) plus its suffix-29 twin. */
const VHHH_REF = { lat: 22.30888891965151, lon: 113.91472220420837 }

function parkingBuffer(
  nameCode: number,
  suffix: number,
  number: number,
  heading: number,
  biasX: number,
  biasZ: number
): RawBuffer {
  return buffer((w) => {
    w.writeInt32(nameCode)
    w.writeInt32(suffix)
    w.writeInt32(number)
    w.writeFloat32(heading)
    w.writeFloat32(biasX)
    w.writeFloat32(biasZ)
  })
}

/**
 * @param handle The fake connection.
 * @param type The record's type.
 * @param itemIndex Its index among its kind.
 * @param data Its bytes.
 */
function taxiRecord(handle: FakeHandle, type: FacilityDataType, itemIndex: number, data: RawBuffer): void {
  handle.emit('facilityData', { type, userRequestId: NavdataDefId.TAXI_NETWORK, itemIndex, data })
}

const EGKB_REF = { lat: 51.33098021149635, lon: 0.03246232867240906 }

describe('fetchTaxiNetwork', () => {
  it('asks for points, paths, names and stands in one request, unfiltered', () => {
    const handle = new FakeHandle()
    void fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'EGKB')

    expect(handle.requestFacilityData).toHaveBeenCalledTimes(1)
    expect(handle.requestFacilityData).toHaveBeenCalledWith(
      NavdataDefId.TAXI_NETWORK,
      NavdataDefId.TAXI_NETWORK,
      'EGKB'
    )
    expect(handle.addFacilityDataDefinitionFilter).not.toHaveBeenCalled()
    const fields = handle.addToFacilityDefinition.mock.calls.map((call) => call[1] as string)
    expect(fields.filter((f) => f.startsWith('OPEN '))).toEqual([
      'OPEN AIRPORT',
      'OPEN TAXI_POINT',
      'OPEN TAXI_PATH',
      'OPEN TAXI_NAME',
      'OPEN TAXI_PARKING'
    ])
  })

  it('positions and names the drivable and runway paths, and drops parking, closed, vehicle and road paths', async () => {
    const handle = new FakeHandle()
    const promise = fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'EGKB')

    // Real EGKB reference point and two real TAXI_POINT records (the runway 03/21 centerline's threshold points).
    taxiRecord(
      handle,
      FacilityDataType.AIRPORT,
      0xffffffff,
      airportLatLonBuffer('EGKB', EGKB_REF.lat, EGKB_REF.lon)
    )
    taxiRecord(handle, FacilityDataType.TAXI_POINT, 0, taxiPointBuffer(389.0379, 823.5693))
    // HOLD_SHORT_NO_DRAW, the type seen live at VHHH
    taxiRecord(handle, FacilityDataType.TAXI_POINT, 7, taxiPointBuffer(-394.4898, -794.5173, 5))
    taxiRecord(handle, FacilityDataType.TAXI_PATH, 0, taxiPathBuffer(1, 0, 7, 0))
    taxiRecord(handle, FacilityDataType.TAXI_PATH, 1, taxiPathBuffer(4, 7, 0, 1))
    taxiRecord(handle, FacilityDataType.TAXI_PATH, 2, taxiPathBuffer(2, 0, 7, 0, [3, 0]))
    for (const [index, type] of [3, 5, 6, 7].entries())
      taxiRecord(handle, FacilityDataType.TAXI_PATH, 3 + index, taxiPathBuffer(type, 0, 7, 0))
    taxiRecord(handle, FacilityDataType.TAXI_NAME, 0, taxiNameBuffer(''))
    taxiRecord(handle, FacilityDataType.TAXI_NAME, 1, taxiNameBuffer('A'))
    handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_NETWORK })

    const result = await promise
    expect(result.icao).toBe('EGKB')
    expect(result.segments.map((s) => s.pathType)).toEqual([1, 4, 2])
    expect(result.segments[0]).toMatchObject({
      startLat: expect.closeTo(51.33823, 3),
      startLon: expect.closeTo(0.03809, 3),
      name: null,
      startHoldShort: false,
      endHoldShort: true,
      widthM: 23,
      runwayNumber: null
    })
    expect(result.segments[1]).toMatchObject({ name: 'A', startHoldShort: true, endHoldShort: false })
    expect(result.segments[2]).toMatchObject({ runwayNumber: 3, runwayDesignator: 0 })
  })

  it("positions each stand and names it the way ATC does: VHHH's GATE_N 32 is 'N32'", async () => {
    const handle = new FakeHandle()
    const promise = fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'VHHH')
    taxiRecord(
      handle,
      FacilityDataType.AIRPORT,
      0xffffffff,
      airportLatLonBuffer('VHHH', VHHH_REF.lat, VHHH_REF.lon)
    )
    taxiRecord(
      handle,
      FacilityDataType.TAXI_PARKING,
      0,
      parkingBuffer(25, 0, 32, 161.01141357421875, 1431.80419921875, 585.1451416015625)
    )
    taxiRecord(
      handle,
      FacilityDataType.TAXI_PARKING,
      1,
      parkingBuffer(25, 29, 32, 161.0146484375, 1420.47412109375, 579.7236328125)
    )
    handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_NETWORK })

    const { stands } = await promise
    expect(stands).toHaveLength(2)
    expect(stands[0]).toMatchObject({
      name: 'N32',
      nameCode: 25,
      number: 32,
      suffix: 0,
      lat: expect.closeTo(22.31414534, 6),
      lon: expect.closeTo(113.92862486, 6)
    })
    expect(stands[1]).toMatchObject({ name: 'N32', suffix: 29 })
  })

  it('drops a path whose START/END point was never received, rather than emitting a broken segment', async () => {
    const handle = new FakeHandle()
    const promise = fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'EGKB')
    taxiRecord(
      handle,
      FacilityDataType.AIRPORT,
      0xffffffff,
      airportLatLonBuffer('EGKB', EGKB_REF.lat, EGKB_REF.lon)
    )
    // Only point 0 arrives — point 99 (referenced by the path below) never does.
    taxiRecord(handle, FacilityDataType.TAXI_POINT, 0, taxiPointBuffer(0, 0))
    taxiRecord(handle, FacilityDataType.TAXI_PATH, 0, taxiPathBuffer(1, 0, 99, 0))
    handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_NETWORK })

    const result = await promise
    expect(result.segments).toEqual([])
  })

  it('returns nothing when the airport reference point never arrived', async () => {
    const handle = new FakeHandle()
    const promise = fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'VHHH')
    taxiRecord(handle, FacilityDataType.TAXI_POINT, 0, taxiPointBuffer(0, 0))
    taxiRecord(handle, FacilityDataType.TAXI_PATH, 0, taxiPathBuffer(1, 0, 0, 0))
    taxiRecord(handle, FacilityDataType.TAXI_PARKING, 0, parkingBuffer(25, 0, 32, 161, 0, 0))
    handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_NETWORK })

    await expect(promise).resolves.toEqual({ icao: 'VHHH', segments: [], stands: [] })
  })

  it('re-asks with the region for an ambiguous ICAO, and rejects on a SimConnect exception', async () => {
    const handle = new FakeHandle()
    const promise = fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'VHHH')
    handle.emit('facilityMinimalList', {
      requestID: NavdataDefId.TAXI_NETWORK,
      data: [{ icao: { region: 'VH' } }]
    })
    expect(handle.requestFacilityData).toHaveBeenLastCalledWith(
      NavdataDefId.TAXI_NETWORK,
      NavdataDefId.TAXI_NETWORK,
      'VHHH',
      'VH'
    )
    handle.emit('exception', { exceptionName: 'ERROR', index: 3 })
    await expect(promise).rejects.toThrow('SimConnect exception fetching VHHH taxi network')
  })
})

describe('every facility fetch', () => {
  const LISTENED = ['facilityData', 'facilityDataEnd', 'facilityMinimalList', 'exception'] as const
  const listening = (handle: FakeHandle): number =>
    LISTENED.reduce((n, event) => n + handle.listenerCount(event), 0)

  it('times out with its own message, and stops listening', async () => {
    vi.useFakeTimers()
    try {
      for (const [fetch, timeoutMs, message] of [
        [fetchAirportNavdata, 20_000, 'Facility fetch for ZJSY timed out'],
        [fetchTaxiNetwork, 30_000, 'Taxi network fetch for ZJSY timed out']
      ] as const) {
        const handle = new FakeHandle()
        const promise = fetch(handle as unknown as SimConnectConnection, 'ZJSY')
        promise.catch(() => undefined)
        vi.advanceTimersByTime(timeoutMs - 1)
        expect(listening(handle)).toBe(4)
        vi.advanceTimersByTime(1)
        await expect(promise).rejects.toThrow(message)
        expect(listening(handle)).toBe(0)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops listening once it resolves or rejects, and ignores anything after', async () => {
    const navdata = new FakeHandle()
    const resolved = fetchAirportNavdata(navdata as unknown as SimConnectConnection, 'EGLL')
    endAll(navdata)
    await expect(resolved).resolves.toMatchObject({ icao: 'EGLL', runways: [] })
    expect(listening(navdata)).toBe(0)

    const taxi = new FakeHandle()
    const rejected = fetchTaxiNetwork(taxi as unknown as SimConnectConnection, 'EGLL')
    taxi.emit('exception', { exceptionName: 'ERROR', index: 1 })
    await expect(rejected).rejects.toThrow('SimConnect exception fetching EGLL taxi network: ERROR (index 1)')
    expect(listening(taxi)).toBe(0)
  })

  it("doesn't re-ask for a definition that has already ended, or without a region", () => {
    const handle = new FakeHandle()
    void fetchAirportNavdata(handle as unknown as SimConnectConnection, 'EGLL').catch(() => undefined)
    handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.RUNWAYS })
    const asked = handle.requestFacilityData.mock.calls.length
    handle.emit('facilityMinimalList', {
      requestID: NavdataDefId.RUNWAYS,
      data: [{ icao: { region: 'EG' } }]
    })
    handle.emit('facilityMinimalList', { requestID: NavdataDefId.DEPARTURES, data: [] })
    expect(handle.requestFacilityData.mock.calls.length).toBe(asked)
    handle.emit('facilityMinimalList', {
      requestID: NavdataDefId.DEPARTURES,
      data: [{ icao: { region: 'EG' } }]
    })
    expect(handle.requestFacilityData).toHaveBeenLastCalledWith(
      NavdataDefId.DEPARTURES,
      NavdataDefId.DEPARTURES,
      'EGLL',
      'EG'
    )
    handle.emit('exception', { exceptionName: 'ERROR', index: 0 })
  })

  it('names the airport and the SimConnect exception when the navdata fetch fails', async () => {
    const handle = new FakeHandle()
    const promise = fetchAirportNavdata(handle as unknown as SimConnectConnection, 'VHHH')
    handle.emit('exception', { exceptionName: 'UNRECOGNIZED_ID', index: 4 })
    await expect(promise).rejects.toThrow(
      'SimConnect exception fetching VHHH navdata: UNRECOGNIZED_ID (index 4)'
    )
  })
})

describe('fetchTaxiNetwork on a real response', () => {
  // Every record the sim sent for EGKB (MSFS 2024 default scenery) to the production request, captured 2026-10-23 by
  // scripts/spike-taxi-network-fetch.ts.
  const capture = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', 'taxi-network-egkb.json'), 'utf8')
  ) as { records: { type: FacilityDataType; itemIndex: number; bytes: string }[] }

  it('reads every record to its last byte and keeps the drivable and runway paths, names and stands', async () => {
    const handle = new FakeHandle()
    const promise = fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'EGKB')
    const left: number[] = []
    for (const record of capture.records) {
      const data = new RawBuffer(Buffer.from(record.bytes, 'base64'))
      taxiRecord(handle, record.type, record.itemIndex, data)
      left.push(data.remaining())
    }
    handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_NETWORK })
    const { segments, stands } = await promise

    expect(left.every((n) => n === 0)).toBe(true)
    // The live run: path types {2: 11, 3: 25, 4: 434}, the 25 parking paths dropped.
    expect(segments).toHaveLength(445)
    expect(segments.filter((s) => s.pathType === 2)).toHaveLength(11)
    expect(
      segments.filter((s) => s.pathType === 2).every((s) => s.runwayNumber === 3 && s.runwayDesignator === 0)
    ).toBe(true)
    expect(segments.filter((s) => s.pathType === 4).every((s) => s.runwayNumber === null)).toBe(true)
    expect(new Set(segments.map((s) => s.name).filter((n) => n !== null)).size).toBe(22)
    expect(segments.some((s) => s.startHoldShort || s.endHoldShort)).toBe(true)
    expect(stands).toHaveLength(25)
    // Everything within 3 km of the airport reference point.
    for (const { lat, lon } of [...stands, ...segments.map((s) => ({ lat: s.startLat, lon: s.startLon }))]) {
      expect(Math.abs(lat - EGKB_REF.lat)).toBeLessThan(0.03)
      expect(Math.abs(lon - EGKB_REF.lon)).toBeLessThan(0.05)
    }
  })
})
