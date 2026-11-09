import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { completeFlight, createFlight, getFlightIdByUuid, getFlightUuidById } from '../db/flight-repo'
import { createTrackPoint, listCompletedFlightsWithoutTrack, listTrackPoints } from '../db/track-point-repo'
import { TRACK_PAGE_ROWS, trackPointsPage, twinSyncQueries } from '../lan/twin-sync'
import { syncTrackPoints } from './track-point-sync'

vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

function freshDb(): WingLogDb {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

function point(flightId: number, i: number) {
  return {
    flightId,
    tsUtc: new Date(Date.UTC(2026, 10, 8, 12, 0, i)).toISOString(),
    latitude: 51 + i / 1000,
    longitude: -0.4,
    altitudeM: 100 + i,
    pressureAltitudeM: null,
    altitudeAglM: 0,
    indicatedAirspeedMs: 70,
    machSpeed: 0.2,
    groundSpeedMs: 70,
    verticalSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    phase: 'climb' as const,
    onGround: false,
    fuelKg: 5000,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    resumeSegment: 0,
    simRate: 1,
    excludedReason: null
  }
}

describe('the track of completed flights, from the sim PC', () => {
  let host: WingLogDb
  let client: WingLogDb

  /** A completed flight on the host with n points, and the same flight (by uuid) without points on the client. */
  function seed(n: number): { hostId: number; clientId: number; uuid: string } {
    const aircraftId = createAircraft(host, { registration: 'G-HOST', icaoType: 'A320' }).id
    const flight = createFlight(host, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC', status: 'active' })
    for (let i = 0; i < n; i++) createTrackPoint(host, point(flight.id, i) as never)
    completeFlight(host, flight.id, 3000)
    const uuid = getFlightUuidById(host, flight.id) as string
    // The client got the flight row by sync, and not the points.
    const clientAircraft = createAircraft(client, { registration: 'G-HOST', icaoType: 'A320' }).id
    const copy = createFlight(client, {
      aircraftId: clientAircraft,
      depIcao: 'EGLL',
      arrIcao: 'EGCC',
      status: 'completed'
    })
    client.run(`UPDATE flight SET uuid = '${uuid}' WHERE id = ${copy.id}` as never)
    return { hostId: flight.id, clientId: copy.id, uuid }
  }

  beforeEach(() => {
    host = freshDb()
    client = freshDb()
  })

  function ask() {
    const queries = twinSyncQueries(host)
    return (name: string, ...args: unknown[]) =>
      Promise.resolve(JSON.parse(JSON.stringify(queries[name](...JSON.parse(JSON.stringify(args))))))
  }

  it('serves a flight’s points in pages, without ids, and says where the next page begins', () => {
    const { uuid } = seed(TRACK_PAGE_ROWS + 5)
    const first = trackPointsPage(host, uuid, 0)
    expect(first.points).toHaveLength(TRACK_PAGE_ROWS)
    expect(first.next).toBe(TRACK_PAGE_ROWS)
    expect(first.points[0]).not.toHaveProperty('id')
    expect(first.points[0]).not.toHaveProperty('flightId')
    const second = trackPointsPage(host, uuid, TRACK_PAGE_ROWS)
    expect(second.points).toHaveLength(5)
    expect(second.next).toBeNull()
    expect(trackPointsPage(host, 'unknown', 0)).toEqual({ points: [], next: null })
  })

  it('brings a completed flight’s whole track to the client, once, under the client’s own flight id', async () => {
    const { clientId, hostId } = seed(TRACK_PAGE_ROWS + 5)
    expect(listCompletedFlightsWithoutTrack(client).map((f) => f.id)).toEqual([clientId])
    expect(await syncTrackPoints(client, ask())).toBe(1)
    const points = listTrackPoints(client, clientId)
    expect(points).toHaveLength(TRACK_PAGE_ROWS + 5)
    expect(points.every((p) => p.flightId === clientId)).toBe(true)
    expect(points.map((p) => p.tsUtc)).toEqual(listTrackPoints(host, hostId).map((p) => p.tsUtc))
    // Done: nothing is asked for again.
    expect(listCompletedFlightsWithoutTrack(client)).toEqual([])
    expect(await syncTrackPoints(client, ask())).toBe(0)
  })

  it('leaves a flight with no recorded track alone, and a flight not completed', async () => {
    seed(0)
    expect(await syncTrackPoints(client, ask())).toBe(0)
    const aircraftId = createAircraft(client, { registration: 'G-OTHR', icaoType: 'A320' }).id
    createFlight(client, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC', status: 'active' })
    expect(listCompletedFlightsWithoutTrack(client)).toHaveLength(1)
  })

  it('asks only for the tracks the sim PC has: a flight it has none for costs no round trip', async () => {
    const { clientId, uuid } = seed(5)
    // A second completed flight the sim PC never recorded (imported from a logbook): it has no track there either.
    const otherAircraft = createAircraft(client, { registration: 'G-IMPT', icaoType: 'A320' }).id
    createFlight(client, { aircraftId: otherAircraft, depIcao: 'EGLL', arrIcao: 'EGPH', status: 'completed' })
    expect(listCompletedFlightsWithoutTrack(client)).toHaveLength(2)
    const asked: string[] = []
    const inner = ask()
    expect(
      await syncTrackPoints(client, (name, ...args) => {
        asked.push(name)
        return inner(name, ...args)
      })
    ).toBe(1)
    expect(listTrackPoints(client, clientId)).toHaveLength(5)
    // One question for which flights have a track, then pages for the one that does.
    expect(asked.filter((name) => name === 'sync.trackedFlights')).toHaveLength(1)
    expect(asked.filter((name) => name === 'sync.trackPoints')).toHaveLength(1)
    expect(uuid).toBeTruthy()
  })

  it('asks for every flight when the sim PC cannot say which have a track, as an older one could not', async () => {
    const { clientId } = seed(3)
    const inner = ask()
    expect(
      await syncTrackPoints(client, (name, ...args) =>
        name === 'sync.trackedFlights' ? Promise.reject(new Error('Unknown query')) : inner(name, ...args)
      )
    ).toBe(1)
    expect(listTrackPoints(client, clientId)).toHaveLength(3)
  })

  it('lists the flights that have a track, and only those', () => {
    const { uuid } = seed(2)
    const other = createAircraft(host, { registration: 'G-NOTR', icaoType: 'A320' }).id
    createFlight(host, { aircraftId: other, depIcao: 'EGLL', arrIcao: 'EGPH', status: 'completed' })
    expect(twinSyncQueries(host)['sync.trackedFlights']()).toEqual([uuid])
  })

  it('refuses a point that is not a point, keeps the rest, and refuses an answer that is not a page', async () => {
    const { clientId, uuid } = seed(0)
    const good = point(0, 1) as Record<string, unknown>
    delete good.flightId
    const bad = { ...good, latitude: 'north' }
    expect(await syncTrackPoints(client, () => Promise.resolve({ points: [good, bad], next: null }))).toBe(1)
    expect(listTrackPoints(client, clientId)).toHaveLength(1)
    expect(getFlightIdByUuid(client, uuid)).toBe(clientId)
    await expect(syncTrackPoints(freshWithMissing(), () => Promise.resolve('nope'))).rejects.toThrow(
      'not points'
    )
  })

  /** A database with one completed flight and no points. */
  function freshWithMissing(): WingLogDb {
    const db = freshDb()
    const aircraftId = createAircraft(db, { registration: 'G-ZZZZ', icaoType: 'A320' }).id
    createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC', status: 'completed' })
    return db
  }

  it('refuses a bad flight or offset in the lookup', () => {
    const queries = twinSyncQueries(host)
    expect(() => queries['sync.trackPoints'](5, 0)).toThrow('Invalid flight')
    expect(() => queries['sync.trackPoints']('uuid', -1)).toThrow('Invalid offset')
    expect(() => queries['sync.trackPoints']('uuid', 1.5)).toThrow('Invalid offset')
  })
})
