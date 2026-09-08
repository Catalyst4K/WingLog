import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { FacilityDataType, RawBuffer, type SimConnectConnection } from 'node-simconnect'
import { NavdataDefId } from '../sim/facility-fields'
import { fetchAirportNavdata } from './sim-facilities-fetch'

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
}

function endAll(handle: FakeHandle): void {
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.RUNWAYS })
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.DEPARTURES })
  handle.emit('facilityDataEnd', { userRequestId: NavdataDefId.ARRIVALS })
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

  it('registers the facility definitions and issues one request per definition, request id == definition id', async () => {
    const handle = new FakeHandle()
    const promise = fetchAirportNavdata(handle as unknown as SimConnectConnection, 'VHHH')

    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.RUNWAYS, NavdataDefId.RUNWAYS, 'VHHH')
    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.DEPARTURES, NavdataDefId.DEPARTURES, 'VHHH')
    expect(handle.requestFacilityData).toHaveBeenCalledWith(NavdataDefId.ARRIVALS, NavdataDefId.ARRIVALS, 'VHHH')
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
