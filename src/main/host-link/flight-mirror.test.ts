import { describe, expect, it } from 'vitest'
import type { LanFlightSnapshot, TrackPoint } from '@shared/ipc'
import { FlightMirror, HELD_BACK, mapFlightTopic } from './flight-mirror'

const HOST_ID = 7
const UUID = 'flight-uuid-1'

function snapshot(
  overrides: { tracking?: boolean; uuid?: string | null; flightId?: number } = {}
): LanFlightSnapshot {
  return {
    flight: {
      flightId: overrides.flightId ?? HOST_ID,
      uuid: overrides.uuid === undefined ? UUID : overrides.uuid,
      tracking: overrides.tracking ?? true,
      depIcao: 'EGLL',
      arrIcao: 'EGCC'
    },
    trackPoints: []
  } as unknown as LanFlightSnapshot
}

function point(id: number, flightId: number, phase: TrackPoint['phase'] = 'climb'): TrackPoint {
  return { id, flightId, phase, latitude: 51, longitude: -0.4 } as unknown as TrackPoint
}

describe('FlightMirror', () => {
  /** A mirror whose database knows the flight as local id 3 once `synced` is true. */
  function make(synced = true): FlightMirror {
    return new FlightMirror((uuid) => (synced && uuid === UUID ? 3 : undefined))
  }

  it('knows nothing before the sim PC shows a flight', () => {
    const mirror = make()
    expect(mirror.active()).toBeNull()
    expect(mirror.mapPoint(point(1, HOST_ID))).toBeNull()
    expect(mirror.livePoints(3)).toBeNull()
  })

  it('re-labels the sim PC’s points with this computer’s id for the same flight, found by uuid', () => {
    const mirror = make()
    mirror.setFlight(snapshot(), () => [])
    expect(mirror.mapPoint(point(1, HOST_ID))).toMatchObject({ id: 1, flightId: 3 })
    expect(mirror.localIdOf(HOST_ID)).toBe(3)
    // Another flight id that happens to equal this computer’s own is not this flight.
    expect(mirror.mapPoint(point(2, 3))).toBeNull()
  })

  it('holds a point back until the flight has synced, so it is never shown against the wrong flight', () => {
    const mirror = make(false)
    mirror.setFlight(snapshot(), () => [])
    expect(mirror.mapPoint(point(1, HOST_ID))).toBeNull()
    expect(mirror.active()).toBeNull()
  })

  it('says a flight is being tracked only when the sim PC is tracking it, with the latest phase', () => {
    const mirror = make()
    mirror.setFlight(snapshot({ tracking: false }), () => [])
    expect(mirror.active()).toBeNull()
    mirror.setFlight(snapshot(), () => [])
    expect(mirror.active()).toEqual({ flightId: 3, phase: 'preflight' })
    mirror.mapPoint(point(5, HOST_ID, 'cruise'))
    expect(mirror.active()).toEqual({ flightId: 3, phase: 'cruise' })
    mirror.setFlight(snapshot({ tracking: false }), () => [])
    mirror.setFlight(snapshot(), () => [])
    expect(mirror.active()).toEqual({ flightId: 3, phase: 'preflight' })
  })

  it('gives the points recorded so far of the tracked flight, and nothing for any other flight', () => {
    const mirror = make()
    const recorded = [point(1, HOST_ID), point(2, HOST_ID)]
    mirror.setFlight(snapshot(), () => recorded)
    expect(mirror.livePoints(3)?.map((p) => [p.id, p.flightId])).toEqual([
      [1, 3],
      [2, 3]
    ])
    expect(mirror.livePoints(4)).toBeNull()
    mirror.setFlight(snapshot({ tracking: false }), () => recorded)
    expect(mirror.livePoints(3)).toBeNull()
  })

  it('refuses a flight with no uuid, and forgets everything when cleared', () => {
    const mirror = make()
    mirror.setFlight(snapshot({ uuid: null }), () => [])
    expect(mirror.active()).toBeNull()
    mirror.setFlight(snapshot(), () => [])
    mirror.clear()
    expect(mirror.active()).toBeNull()
    expect(mirror.livePoints(3)).toBeNull()
  })
})

describe('mapFlightTopic', () => {
  const mirror = new FlightMirror((uuid) => (uuid === UUID ? 3 : undefined))
  mirror.setFlight(snapshot(), () => [])

  it('maps a point, and drops one whose flight is not known here', () => {
    expect(mapFlightTopic(mirror, 'trackingPoint', point(1, HOST_ID))).toMatchObject({ flightId: 3 })
    expect(mapFlightTopic(mirror, 'trackingPoint', point(1, 99))).toBe(HELD_BACK)
  })

  it('maps the points of a cleanup, keeping only the ones it can, and drops it when none', () => {
    const mapped = mapFlightTopic(mirror, 'trackingPointsUpdated', [
      point(1, HOST_ID),
      point(2, 99)
    ]) as TrackPoint[]
    expect(mapped.map((p) => p.id)).toEqual([1])
    expect(mapFlightTopic(mirror, 'trackingPointsUpdated', [point(2, 99)])).toBe(HELD_BACK)
  })

  it('passes every other topic on as it came', () => {
    const payload = { state: 'connected' }
    expect(mapFlightTopic(mirror, 'gsxRemoteStatus', payload)).toBe(payload)
  })

  it('passes a null on as a null: the host clearing a topic is not a value held back', () => {
    for (const topic of [
      'gsxRoutine',
      'taxiRoute',
      'plannedRoute',
      'gsxRemotePrompt',
      'gsxRemoteGate',
      'beyondAtcArrival'
    ]) {
      expect(mapFlightTopic(mirror, topic, null), topic).toBeNull()
    }
  })
})
