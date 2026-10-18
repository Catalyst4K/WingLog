import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BrowserWindow } from 'electron'
import { IpcChannels, type NewTrackPoint, type SimTelemetry } from '@shared/ipc'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { completeFlight, createFlight, recordOff, recordOn, startFlight } from '../db/flight-repo'
import { createLanding } from '../db/landing-repo'
import { createTrackPoint, listTrackPoints } from '../db/track-point-repo'
import { buildLandingRecord } from '../tracking/landing-capture'
import { registerLogbookHandlers } from './logbook-handlers'
import { fakeIpc } from './fake-ipc'

const openExternal = vi.fn()
vi.mock('electron', () => ({ shell: { openExternal: (url: string) => openExternal(url) } }))
const importLogbookCsv = vi.fn()
const importLogbookJson = vi.fn()
const exportLogbook = vi.fn()
vi.mock('../db/logbook-import', () => ({
  importLogbookCsv: (...args: unknown[]) => importLogbookCsv(...args),
  importLogbookJson: (...args: unknown[]) => importLogbookJson(...args),
  exportLogbook: (...args: unknown[]) => exportLogbook(...args)
}))

// A touchdown on EGLL 27L, about 400 m past the threshold.
const TOUCHDOWN = {
  latitude: 51.4649,
  longitude: -0.4398,
  headingTrueDeg: 269.7,
  verticalSpeedMs: -1.2,
  gForce: 1.2,
  pitchDeg: 3,
  bankDeg: 0,
  indicatedAirspeedMs: 68,
  groundSpeedMs: 70,
  windSpeedMs: 5,
  windDirectionDeg: 250,
  flapsHandleIndex: 4
} as SimTelemetry

function point(flightId: number, i: number, excludedReason: 'resume-spurious' | null = null): NewTrackPoint {
  return {
    flightId,
    tsUtc: new Date(Date.parse('2026-10-05T12:00:00Z') + i * 1000).toISOString(),
    latitude: 51.47 + i * 0.001,
    longitude: -0.45,
    altitudeM: 25,
    pressureAltitudeM: null,
    altitudeAglM: 0,
    indicatedAirspeedMs: 5,
    machSpeed: 0,
    groundSpeedMs: 5,
    verticalSpeedMs: 0,
    headingTrueDeg: 0,
    pitchDeg: 0,
    bankDeg: 0,
    phase: 'taxi' as const,
    onGround: true,
    fuelKg: 5000,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    resumeSegment: 0,
    simRate: 1,
    excludedReason
  }
}

describe('logbook IPC handlers', () => {
  let db: WingLogDb
  let invoke: ReturnType<typeof fakeIpc>['invoke']
  let flightId: number
  const sync = vi.fn()
  const window = {} as BrowserWindow

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    sync.mockClear()
    openExternal.mockReset()
    const aircraft = createAircraft(db, { registration: 'G-EUPT', icaoType: 'A319' })
    flightId = createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' }).id
    startFlight(db, flightId, 6000)
    recordOff(db, flightId)
    recordOn(db, flightId)
    completeFlight(db, flightId, 3000)
    const ipc = fakeIpc()
    invoke = ipc.invoke
    registerLogbookHandlers(ipc.ipcMain, { db, window, scheduleBackgroundSync: sync })
  })

  it('lists flights, a flight, and the statistics', () => {
    expect((invoke(IpcChannels.flightList) as { id: number }[]).map((f) => f.id)).toEqual([flightId])
    expect((invoke(IpcChannels.logbookListCompletedFlights) as { id: number }[]).map((f) => f.id)).toEqual([
      flightId
    ])
    expect(invoke(IpcChannels.logbookGetFlight, flightId)).toMatchObject({ id: flightId })
    expect(invoke(IpcChannels.logbookGetFlight, 'x')).toBeNull()
    expect(invoke(IpcChannels.logbookGetFlight, 999)).toBeNull()
    expect(invoke(IpcChannels.logbookGetStats)).toMatchObject({ totalFlights: 1 })
    expect(invoke(IpcChannels.logbookFleetStats)).toHaveLength(1)
    expect(invoke(IpcChannels.logbookListInvoices, flightId)).toEqual([])
    expect(invoke(IpcChannels.logbookListFlightScores)).toEqual([])
  })

  it("lists a flight's landings with the runway and score, and all landings", () => {
    createLanding(db, buildLandingRecord(flightId, 1, 'EGLL', TOUCHDOWN, '2026-10-05T12:30:00Z'))
    const [landing] = invoke(IpcChannels.logbookListLandings, flightId) as {
      runwayIdent: string
      runway: unknown
      score: unknown
    }[]
    expect(landing.runwayIdent).toBe('27L')
    expect(landing.runway).not.toBeNull()
    expect(landing.score).not.toBeNull()
    expect(invoke(IpcChannels.logbookListLandings, 999)).toEqual([])
    expect(invoke(IpcChannels.logbookListAllLandings)).toHaveLength(1)
  })

  it('returns the track without excluded points, and cleans it up on request', () => {
    createTrackPoint(db, point(flightId, 0))
    createTrackPoint(db, point(flightId, 1, 'resume-spurious'))
    createTrackPoint(db, point(flightId, 2))
    expect(invoke(IpcChannels.trackPointList, flightId)).toHaveLength(2)
    expect(invoke(IpcChannels.trackPointCleanup, flightId)).toEqual({ excludedCount: 0, resegmentedCount: 0 })
    expect(sync).not.toHaveBeenCalled()
  })

  it('opens the OFP PDF only when the flight has one', async () => {
    expect(await invoke(IpcChannels.logbookOpenOfpPdf, flightId)).toBe(false)
    expect(await invoke(IpcChannels.logbookOpenOfpPdf, 999)).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('imports (syncing only when something came in) and exports', async () => {
    importLogbookCsv.mockResolvedValueOnce(null)
    importLogbookJson.mockResolvedValueOnce({ added: 3 })
    expect(await invoke(IpcChannels.logbookImportCsv)).toBeNull()
    expect(await invoke(IpcChannels.logbookImportJson)).toEqual({ added: 3 })
    expect(sync).toHaveBeenCalledTimes(1)
    invoke(IpcChannels.logbookExport, 'csv')
    expect(exportLogbook).toHaveBeenCalledWith(db, window, 'csv')
  })

  it('draws the great-circle route between two airports', () => {
    expect((invoke(IpcChannels.logbookGreatCircleRoute, 'EGLL', 'KJFK') as unknown[]).length).toBeGreaterThan(
      2
    )
  })

  describe('filling recording gaps from the flight plan (docs/plans/track-gap-fill.md)', () => {
    // A plan along 50 N from 0 to 30 E, and a flight recorded at 1 E and 2 E, then at 12 E and 13 E after a 3 hour gap.
    const OFP = JSON.stringify({
      navlog: {
        fix: [0, 10, 20, 30].map((lon) => ({ pos_long: String(lon), pos_lat: '50' }))
      }
    })
    const fix = (id: number, minute: number, lon: number, resumeSegment: number): NewTrackPoint => ({
      ...point(id, 0),
      tsUtc: new Date(Date.UTC(2026, 9, 5, 12, minute)).toISOString(),
      latitude: 50,
      longitude: lon,
      resumeSegment
    })
    let planned: number

    beforeEach(() => {
      const aircraft = createAircraft(db, { registration: 'G-EUUA', icaoType: 'A320' })
      planned = createFlight(db, {
        aircraftId: aircraft.id,
        depIcao: 'EGLL',
        arrIcao: 'EDDF',
        ofpJson: OFP
      }).id
      createTrackPoint(db, fix(planned, 0, 1, 0))
      createTrackPoint(db, fix(planned, 1, 2, 0))
      createTrackPoint(db, fix(planned, 181, 12, 1))
      createTrackPoint(db, fix(planned, 182, 13, 1))
      sync.mockClear()
    })

    it('estimates the gap along the plan, keeps it with the flight and syncs it, leaving the recorded points alone', () => {
      expect(invoke(IpcChannels.trackEstimateGet, planned)).toEqual([])
      const result = invoke(IpcChannels.trackEstimateFill, planned) as {
        outcome: string
        count: number
        lengthNm: number
      }
      expect(result).toMatchObject({ outcome: 'filled', count: 1 })
      // 2 E to 12 E along 50 N is about 10 degrees of longitude, 6.4 degrees of arc: roughly 385 nm.
      expect(result.lengthNm).toBeGreaterThan(380)
      expect(result.lengthNm).toBeLessThan(390)
      expect(sync).toHaveBeenCalledTimes(1)

      const [stretch] = invoke(IpcChannels.trackEstimateGet, planned) as { coordinates: [number, number][] }[]
      expect(stretch.coordinates[0]).toEqual([2, 50])
      expect(stretch.coordinates.at(-1)).toEqual([12, 50])
      expect(stretch.coordinates.some(([lon]) => lon === 10)).toBe(true)
      expect(listTrackPoints(db, planned)).toHaveLength(4)
    })

    it('removes the estimate again', () => {
      invoke(IpcChannels.trackEstimateFill, planned)
      sync.mockClear()
      invoke(IpcChannels.trackEstimateClear, planned)
      expect(invoke(IpcChannels.trackEstimateGet, planned)).toEqual([])
      expect(sync).toHaveBeenCalledTimes(1)
    })

    it('says so when there is no flight plan route or no gap, and stores nothing', () => {
      expect(invoke(IpcChannels.trackEstimateFill, flightId)).toEqual({
        outcome: 'noRoute',
        count: 0,
        lengthNm: 0
      })
      const aircraft = createAircraft(db, { registration: 'G-EUUB', icaoType: 'A320' })
      const steady = createFlight(db, {
        aircraftId: aircraft.id,
        depIcao: 'EGLL',
        arrIcao: 'EDDF',
        ofpJson: OFP
      }).id
      createTrackPoint(db, fix(steady, 0, 1, 0))
      createTrackPoint(db, fix(steady, 1, 2, 0))
      expect(invoke(IpcChannels.trackEstimateFill, steady)).toEqual({
        outcome: 'noGaps',
        count: 0,
        lengthNm: 0
      })
      expect(invoke(IpcChannels.trackEstimateGet, steady)).toEqual([])
    })

    it('ignores an excluded point when looking for gaps, and ids that are not whole numbers', () => {
      createTrackPoint(db, { ...fix(planned, 90, 7, 0), excludedReason: 'resume-spurious' })
      expect(invoke(IpcChannels.trackEstimateFill, planned)).toMatchObject({ outcome: 'filled', count: 1 })
      expect(invoke(IpcChannels.trackEstimateGet, 'x')).toEqual([])
      expect(invoke(IpcChannels.trackEstimateFill, 'x')).toMatchObject({ outcome: 'noGaps' })
      expect(invoke(IpcChannels.trackEstimateClear, 'x')).toBeUndefined()
    })
  })
})
