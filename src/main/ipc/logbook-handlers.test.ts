import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BrowserWindow } from 'electron'
import { IpcChannels, type NewTrackPoint, type SimTelemetry } from '@shared/ipc'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { completeFlight, createFlight, recordOff, recordOn, startFlight } from '../db/flight-repo'
import { createLanding } from '../db/landing-repo'
import { createTrackPoint } from '../db/track-point-repo'
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
})
