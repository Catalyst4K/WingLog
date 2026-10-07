import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { FacilityDataType, RawBuffer, type SimConnectConnection } from 'node-simconnect'
import { NavdataDefId } from '../sim/facility-fields'
import { fetchAirportNavdata, fetchStands, fetchTaxiNetwork } from './sim-facilities-fetch'

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

function approachBuffer(type: number, suffixCode: number, runwayNumber: number, runwayDesignator: number): RawBuffer {
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
    expect(departure.runwayTransitions).toEqual([{ runwayIdent: '09', legs: [expect.objectContaining({ fixIdent: 'RWYFIX' })] }])
    expect(departure.enrouteTransitions).toEqual([{ name: 'CLEEE', legs: [expect.objectContaining({ fixIdent: 'ENRFIX' })] }])
  })

  it('reassembles an approach\'s transition legs and final segment, real VHHH RNP-Z-07R shape', async () => {
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
    // 2026-09-08 (docs/navdata-notes.md).
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
      { name: 'LIMES', legs: [expect.objectContaining({ fixIdent: 'LIMES' }), expect.objectContaining({ fixIdent: 'VH720' })] }
    ])
    expect(approach.finalLegs.map((l) => l.fixIdent)).toEqual(['VH720', 'RW07R'])
  })

  it('registers the facility definitions and issues one request per definition, request id == definition id', async () => {
    const handle = new FakeHandle()
    const promise = fetchAirportNavdata(handle as unknown as SimConnectConnection, 'VHHH')

    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.RUNWAYS, NavdataDefId.RUNWAYS, 'VHHH')
    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.DEPARTURES, NavdataDefId.DEPARTURES, 'VHHH')
    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.ARRIVALS, NavdataDefId.ARRIVALS, 'VHHH')
    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.APPROACHES, NavdataDefId.APPROACHES, 'VHHH')
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
    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.RUNWAYS, NavdataDefId.RUNWAYS, 'ABCD', 'K1')

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

function taxiPathBuffer(type: number, start: number, end: number, nameIndex: number): RawBuffer {
  return buffer((w) => {
    w.writeInt32(type)
    w.writeInt32(start)
    w.writeInt32(end)
    w.writeInt32(nameIndex)
  })
}

function taxiNameBuffer(name: string): RawBuffer {
  return buffer((w) => w.writeString8(name))
}

function endAllTaxi(handle: FakeHandle): void {
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_POINTS })
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_PATHS_TYPE_1 })
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_PATHS_TYPE_4 })
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_NAMES })
}

describe('fetchTaxiNetwork', () => {
  it('registers two filtered TAXI_PATH definitions (TYPE 1 and TYPE 4) and requests all four', () => {
    const handle = new FakeHandle()
    void fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'EGKB')

    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.TAXI_POINTS, NavdataDefId.TAXI_POINTS, 'EGKB')
    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.TAXI_PATHS_TYPE_1, NavdataDefId.TAXI_PATHS_TYPE_1, 'EGKB')
    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.TAXI_PATHS_TYPE_4, NavdataDefId.TAXI_PATHS_TYPE_4, 'EGKB')
    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.TAXI_NAMES, NavdataDefId.TAXI_NAMES, 'EGKB')
    expect(handle.addFacilityDataDefinitionFilter).toHaveBeenCalledWith(NavdataDefId.TAXI_PATHS_TYPE_1, 'AIRPORT:TAXI_PATH:TYPE', expect.anything())
    expect(handle.addFacilityDataDefinitionFilter).toHaveBeenCalledWith(NavdataDefId.TAXI_PATHS_TYPE_4, 'AIRPORT:TAXI_PATH:TYPE', expect.anything())
  })

  it('resolves points/paths from both filtered TYPE requests into real lat/lon segments, and NAME_INDEX into names', async () => {
    const handle = new FakeHandle()
    const promise = fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'EGKB')

    // Real EGKB reference point + two real captured TAXI_POINT records (the runway 03/21
    // centerline's threshold points, 2026-09-28).
    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.TAXI_POINTS,
      itemIndex: 0xffffffff,
      data: airportLatLonBuffer('EGKB', 51.33098021149635, 0.03246232867240906)
    })
    handle.emit('facilityData', {
      type: FacilityDataType.TAXI_POINT,
      userRequestId: NavdataDefId.TAXI_POINTS,
      itemIndex: 0,
      data: taxiPointBuffer(389.0379, 823.5693)
    })
    handle.emit('facilityData', {
      type: FacilityDataType.TAXI_POINT,
      userRequestId: NavdataDefId.TAXI_POINTS,
      itemIndex: 7,
      data: taxiPointBuffer(-394.4898, -794.5173, 5) // HOLD_SHORT_NO_DRAW, the type seen live at VHHH
    })

    // A TYPE-1 path and a TYPE-4 path, from the two separate filtered requests — both must
    // end up merged into the result.
    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.TAXI_PATHS_TYPE_1,
      itemIndex: 0xffffffff,
      data: airportLatLonBuffer('EGKB', 51.33098021149635, 0.03246232867240906)
    })
    handle.emit('facilityData', {
      type: FacilityDataType.TAXI_PATH,
      userRequestId: NavdataDefId.TAXI_PATHS_TYPE_1,
      itemIndex: 0,
      data: taxiPathBuffer(1, 0, 7, 0) // unnamed (NAME_INDEX 0)
    })
    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.TAXI_PATHS_TYPE_4,
      itemIndex: 0xffffffff,
      data: airportLatLonBuffer('EGKB', 51.33098021149635, 0.03246232867240906)
    })
    handle.emit('facilityData', {
      type: FacilityDataType.TAXI_PATH,
      userRequestId: NavdataDefId.TAXI_PATHS_TYPE_4,
      itemIndex: 0,
      data: taxiPathBuffer(4, 7, 0, 1) // named, NAME_INDEX 1 -> "A"
    })

    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.TAXI_NAMES,
      itemIndex: 0xffffffff,
      data: airportLatLonBuffer('EGKB', 51.33098021149635, 0.03246232867240906)
    })
    handle.emit('facilityData', {
      type: FacilityDataType.TAXI_NAME,
      userRequestId: NavdataDefId.TAXI_NAMES,
      itemIndex: 0,
      data: taxiNameBuffer('')
    })
    handle.emit('facilityData', {
      type: FacilityDataType.TAXI_NAME,
      userRequestId: NavdataDefId.TAXI_NAMES,
      itemIndex: 1,
      data: taxiNameBuffer('A')
    })

    endAllTaxi(handle)

    const result = await promise
    expect(result.icao).toBe('EGKB')
    expect(result.segments).toHaveLength(2)
    expect(result.segments.find((s) => s.name === null)).toMatchObject({
      startLat: expect.closeTo(51.33823, 3),
      startLon: expect.closeTo(0.03809, 3),
      startHoldShort: false,
      endHoldShort: true
    })
    expect(result.segments.find((s) => s.name === 'A')).toMatchObject({ startHoldShort: true, endHoldShort: false })
  })

  it('drops a path whose START/END point was never received, rather than emitting a broken segment', async () => {
    const handle = new FakeHandle()
    const promise = fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'EGKB')

    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.TAXI_POINTS,
      itemIndex: 0xffffffff,
      data: airportLatLonBuffer('EGKB', 51.33098021149635, 0.03246232867240906)
    })
    // Only point 0 arrives — point 99 (referenced by the path below) never does.
    handle.emit('facilityData', {
      type: FacilityDataType.TAXI_POINT,
      userRequestId: NavdataDefId.TAXI_POINTS,
      itemIndex: 0,
      data: taxiPointBuffer(0, 0)
    })
    handle.emit('facilityData', {
      type: FacilityDataType.TAXI_PATH,
      userRequestId: NavdataDefId.TAXI_PATHS_TYPE_1,
      itemIndex: 0,
      data: taxiPathBuffer(1, 0, 99, 0)
    })

    endAllTaxi(handle)

    const result = await promise
    expect(result.segments).toEqual([])
  })

  it('rejects on a SimConnect exception rather than hanging forever', async () => {
    const handle = new FakeHandle()
    const promise = fetchTaxiNetwork(handle as unknown as SimConnectConnection, 'ZZZZ')
    handle.emit('exception', { exceptionName: 'ERROR', index: 0, sendId: 1 })
    await expect(promise).rejects.toThrow(/ZZZZ/)
  })
})

describe('fetchStands (stand-positions.md)', () => {
  // Real VHHH values from the TAXI_PARKING spike, 2026-10-02: the airport reference point and
  // stand N32 (GATE_N = 25) plus its suffix-29 twin.
  const VHHH_REF = { lat: 22.30888891965151, lon: 113.91472220420837 }
  function parkingBuffer(nameCode: number, suffix: number, number: number, heading: number, biasX: number, biasZ: number): RawBuffer {
    return buffer((w) => {
      w.writeInt32(nameCode)
      w.writeInt32(suffix)
      w.writeInt32(number)
      w.writeFloat32(heading)
      w.writeFloat32(biasX)
      w.writeFloat32(biasZ)
    })
  }

  it("positions each stand and names it the way ATC does: VHHH's GATE_N 32 is 'N32'", async () => {
    const handle = new FakeHandle()
    const promise = fetchStands(handle as unknown as SimConnectConnection, 'VHHH')
    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.TAXI_PARKINGS, NavdataDefId.TAXI_PARKINGS, 'VHHH')

    handle.emit('facilityData', {
      type: FacilityDataType.AIRPORT,
      userRequestId: NavdataDefId.TAXI_PARKINGS,
      itemIndex: 0xffffffff,
      data: airportLatLonBuffer('VHHH', VHHH_REF.lat, VHHH_REF.lon)
    })
    handle.emit('facilityData', {
      type: FacilityDataType.TAXI_PARKING,
      userRequestId: NavdataDefId.TAXI_PARKINGS,
      itemIndex: 0,
      data: parkingBuffer(25, 0, 32, 161.01141357421875, 1431.80419921875, 585.1451416015625)
    })
    handle.emit('facilityData', {
      type: FacilityDataType.TAXI_PARKING,
      userRequestId: NavdataDefId.TAXI_PARKINGS,
      itemIndex: 1,
      data: parkingBuffer(25, 29, 32, 161.0146484375, 1420.47412109375, 579.7236328125)
    })
    handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_PARKINGS })

    const stands = await promise
    expect(stands).toHaveLength(2)
    expect(stands[0]).toMatchObject({ name: 'N32', nameCode: 25, number: 32, suffix: 0, lat: expect.closeTo(22.31414534, 6), lon: expect.closeTo(113.92862486, 6) })
    expect(stands[1]).toMatchObject({ name: 'N32', suffix: 29 })
  })

  it('re-asks with the region for an ambiguous ICAO, and rejects on a SimConnect exception', async () => {
    const handle = new FakeHandle()
    const promise = fetchStands(handle as unknown as SimConnectConnection, 'VHHH')
    handle.emit('facilityMinimalList', { requestID: NavdataDefId.TAXI_PARKINGS, data: [{ icao: { region: 'VH' } }] })
    expect(handle.requestFacilityData).toHaveBeenLastCalledWith(NavdataDefId.TAXI_PARKINGS, NavdataDefId.TAXI_PARKINGS, 'VHHH', 'VH')
    handle.emit('exception', { exceptionName: 'ERROR', index: 3 })
    await expect(promise).rejects.toThrow('SimConnect exception fetching VHHH stands')
  })
})

describe('every facility fetch', () => {
  const LISTENED = ['facilityData', 'facilityDataEnd', 'facilityMinimalList', 'exception'] as const
  const listening = (handle: FakeHandle): number => LISTENED.reduce((n, event) => n + handle.listenerCount(event), 0)

  it('times out with its own message, and stops listening', async () => {
    vi.useFakeTimers()
    try {
      for (const [fetch, timeoutMs, message] of [
        [fetchAirportNavdata, 20_000, 'Facility fetch for ZJSY timed out'],
        [fetchTaxiNetwork, 600_000, 'Taxi network fetch for ZJSY timed out'],
        [fetchStands, 60_000, 'Stand fetch for ZJSY timed out']
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
    handle.emit('facilityMinimalList', { requestID: NavdataDefId.RUNWAYS, data: [{ icao: { region: 'EG' } }] })
    handle.emit('facilityMinimalList', { requestID: NavdataDefId.DEPARTURES, data: [] })
    expect(handle.requestFacilityData.mock.calls.length).toBe(asked)
    handle.emit('facilityMinimalList', { requestID: NavdataDefId.DEPARTURES, data: [{ icao: { region: 'EG' } }] })
    expect(handle.requestFacilityData).toHaveBeenLastCalledWith(NavdataDefId.DEPARTURES, NavdataDefId.DEPARTURES, 'EGLL', 'EG')
    handle.emit('exception', { exceptionName: 'ERROR', index: 0 })
  })

  it('names the airport and the SimConnect exception when the navdata fetch fails', async () => {
    const handle = new FakeHandle()
    const promise = fetchAirportNavdata(handle as unknown as SimConnectConnection, 'VHHH')
    handle.emit('exception', { exceptionName: 'UNRECOGNIZED_ID', index: 4 })
    await expect(promise).rejects.toThrow('SimConnect exception fetching VHHH navdata: UNRECOGNIZED_ID (index 4)')
  })

  it('only counts stands for its own request, and only once the airport reference has arrived', async () => {
    const handle = new FakeHandle()
    const promise = fetchStands(handle as unknown as SimConnectConnection, 'VHHH')
    handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_POINTS })
    handle.emit('facilityData', { type: FacilityDataType.TAXI_PARKING, userRequestId: NavdataDefId.TAXI_PARKINGS, itemIndex: 0, data: buffer(() => undefined) })
    handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.TAXI_PARKINGS })
    await expect(promise).resolves.toEqual([])
  })
})
