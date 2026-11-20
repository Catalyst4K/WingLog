/**
 * The sim connection and tracking's start-up wiring: connectSim picks the live sim or a replayed capture
 * from the e2e environment variables; startTracking connects tracking to the live views, background sync,
 * auto-start and (dev builds only) diagnostics; recordParkedStandOnCompletion records where a completed
 * flight finished. A real in-memory database and a real TrackingController throughout; only the sim, the
 * sim's facility lookups and Electron are fakes.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels, type SimTelemetry } from '@shared/ipc'
import type { NavdataStand } from '@shared/types/navdata'
import type { TrackPoint } from '@shared/types/flight'
import { createAircraft } from './db/aircraft-repo'
import { createDb, type WingLogDb } from './db/client'
import {
  completeFlight,
  createFlight,
  getFlight,
  listLastParkedByAircraft,
  startFlight
} from './db/flight-repo'
import { setTrackingSettings } from './db/settings-repo'
import { LiveHub } from './live/LiveHub'
import { logger } from './logging/logger'
import type { SimFacilitiesProvider } from './navdata/sim-facilities-provider'
import { ReplaySimConnectService } from './sim/ReplaySimConnectService'
import { SimConnectService } from './sim/SimConnectService'
import type { TrackingController } from './tracking/TrackingController'

const electron = vi.hoisted(() => ({ userDataDir: '', handle: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.userDataDir, on: vi.fn() },
  ipcMain: { handle: electron.handle }
}))

const replayCapture = vi.fn()
vi.mock('./sim/replay-capture', () => ({ replayCapture: (...args: unknown[]) => replayCapture(...args) }))

// The sim's airfield lookup opens its own SimConnect connection; the fake only records what it was asked.
const airfieldResolver = vi.hoisted(() => ({ created: 0, resolve: vi.fn() }))
vi.mock('./airports/sim-airfield', () => ({
  SimAirfieldResolver: class {
    constructor() {
      airfieldResolver.created++
    }
    resolve(...args: unknown[]) {
      return airfieldResolver.resolve(...args)
    }
  }
}))

// The real TrackingController, with the arguments it was constructed with kept for the tests.
const trackingConstruction = vi.hoisted(() => ({ args: [] as unknown[][] }))
vi.mock('./tracking/TrackingController', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tracking/TrackingController')>()
  return {
    TrackingController: class extends actual.TrackingController {
      constructor(...args: ConstructorParameters<typeof actual.TrackingController>) {
        super(...args)
        trackingConstruction.args.push(args)
      }
    }
  }
})

// The dev build's diag.log is a file through electron-log; here the lines go to a list the tests read.
const diagLines = vi.hoisted(() => ({ written: [] as string[], opened: 0 }))
vi.mock('./diagnostics/diag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./diagnostics/diag')>()
  return {
    ...actual,
    openDiagLog: () => {
      diagLines.opened++
      return (line: string) => diagLines.written.push(line)
    }
  }
})

import { connectSim, recordParkedStandOnCompletion, startTracking } from './sim-and-tracking'

function telemetry(overrides: Partial<SimTelemetry> = {}): SimTelemetry {
  return {
    latitude: 51.4775,
    longitude: -0.4614,
    altitudeM: 25,
    pressureAltitudeM: 25,
    altitudeAglM: 0,
    verticalSpeedMs: 0,
    indicatedAirspeedMs: 0,
    trueAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    onGround: true,
    gForce: 1,
    fuelTotalKg: 10000,
    totalWeightKg: 70000,
    windSpeedMs: 3,
    windDirectionDeg: 250,
    engineCombustion1: false,
    gearHandlePosition: 1,
    flapsHandleIndex: 0,
    parkingBrakeOn: true,
    atcId: 'TEST',
    atcModel: 'A320',
    title: 'Fenix A320',
    simRate: 1,
    slewActive: false,
    ...overrides
  }
}

/** How many settled samples AutoStartDetector needs before it fires. */
const SETTLED_SAMPLES = 8

/** A stand-in for the live sim: the events and the last telemetry that tracking uses. */
class FakeSim extends EventEmitter {
  lastTelemetry: SimTelemetry | undefined = telemetry()
  getLastTelemetry(): SimTelemetry | undefined {
    return this.lastTelemetry
  }
}

/** The fake as the live sim, for the functions that take one; the fake has every member they use. */
const asLiveSim = (sim: FakeSim) => sim as unknown as SimConnectService

/**
 * @param db The database.
 * @param arrIcao The flight's arrival airport.
 * @returns The id of a new planned flight on a new aircraft.
 */
function plannedFlight(db: WingLogDb, arrIcao = 'EGCC'): number {
  const aircraft = createAircraft(db, {
    registration: `G-${Math.random().toString(36).slice(2, 6)}`,
    icaoType: 'A320'
  })
  return createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao }).id
}

function newDb(): WingLogDb {
  const db = createDb(':memory:').db
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

beforeEach(() => {
  electron.userDataDir = mkdtempSync(join(tmpdir(), 'winglog-sim-tracking-'))
  electron.handle.mockReset()
  airfieldResolver.created = 0
  airfieldResolver.resolve.mockReset()
  trackingConstruction.args = []
  diagLines.written = []
  diagLines.opened = 0
})

const ENV_NAMES = [
  'WINGLOG_E2E_FIXTURE',
  'WINGLOG_E2E_REPLAY_MODE',
  'WINGLOG_E2E_REPLAY_SPEED',
  'WINGLOG_E2E_REPLAY_HOLD',
  'WINGLOG_E2E_REPLAY_GAP_S',
  'WINGLOG_E2E_REPLAY_STREAMS'
]

afterEach(async () => {
  for (const name of ENV_NAMES) delete process.env[name]
  replayCapture.mockReset()
  vi.unstubAllGlobals()
  // A capture's file is closed a moment after it stops, and Windows will not delete an open file.
  await rm(electron.userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('connectSim', () => {
  it('uses the live sim connection when no fixture is set', () => {
    const { sim, replayStreams } = connectSim()
    expect(sim).toBeInstanceOf(SimConnectService)
    expect(replayStreams).toBeUndefined()
    expect(replayCapture).not.toHaveBeenCalled()
  })

  it('replays the fixture with the options from the environment, handing on no streams by default', () => {
    const replay = { sim: { replayed: true } }
    replayCapture.mockReturnValue(replay)
    process.env.WINGLOG_E2E_FIXTURE = 'flight.ndjson'
    process.env.WINGLOG_E2E_REPLAY_SPEED = '4'
    process.env.WINGLOG_E2E_REPLAY_HOLD = '1'

    const result = connectSim()

    expect(result.sim).toBe(replay.sim)
    expect(result.replayStreams).toBeUndefined()
    expect(replayCapture).toHaveBeenCalledWith(
      'flight.ndjson',
      expect.objectContaining({ mode: 'paced', speedMultiplier: 4, holdUntilReleased: true })
    )
  })

  it.each(['1', 'beyondatc'])(
    'hands on the replayed streams when WINGLOG_E2E_REPLAY_STREAMS is %s',
    (value) => {
      const replay = { sim: {} }
      replayCapture.mockReturnValue(replay)
      process.env.WINGLOG_E2E_FIXTURE = 'flight.ndjson'
      process.env.WINGLOG_E2E_REPLAY_STREAMS = value

      expect(connectSim().replayStreams).toBe(replay)
    }
  )
})

describe('recordParkedStandOnCompletion', () => {
  /** Gate 14 at Manchester, and the next gate along (about 110 m away). */
  const GATE_14: NavdataStand = {
    name: '14',
    number: 14,
    suffix: 0,
    headingDeg: 90,
    lat: 53.3537,
    lon: -2.2749
  }
  const GATE_15: NavdataStand = {
    name: '15',
    number: 15,
    suffix: 0,
    headingDeg: 90,
    lat: 53.3537,
    lon: -2.2733
  }

  let db: WingLogDb
  let sim: FakeSim
  let tracking: TrackingController
  let getStands: ReturnType<typeof vi.fn<(icao: string) => Promise<NavdataStand[]>>>
  let flightId: number

  beforeEach(() => {
    db = newDb()
    sim = new FakeSim()
    sim.lastTelemetry = undefined
    getStands = vi.fn(async () => [GATE_14, GATE_15])
    tracking = startTracking(db, asLiveSim(sim), new LiveHub(), vi.fn()).trackingController
    recordParkedStandOnCompletion(db, asLiveSim(sim), tracking, {
      getStands
    } as unknown as SimFacilitiesProvider)
    flightId = plannedFlight(db, 'EGCC')
    startFlight(db, flightId, 6000)
    completeFlight(db, flightId, 3000)
  })

  it('records the arrival airport stand the aircraft finished at, from where the sim says it is at completion', async () => {
    // The position is read when the flight completes, not when the wiring is made.
    sim.lastTelemetry = telemetry({ latitude: 53.35372, longitude: -2.27332 })

    tracking.emit('completed', flightId)

    await vi.waitFor(() =>
      expect(listLastParkedByAircraft(db)).toEqual([
        { aircraftId: getFlight(db, flightId)?.aircraftId, icao: 'EGCC', stand: '15' }
      ])
    )
    expect(getStands).toHaveBeenCalledWith('EGCC')
  })

  it('records nothing when the aircraft stopped further than a stand reach from any stand', async () => {
    sim.lastTelemetry = telemetry({ latitude: 53.3545, longitude: -2.274 })

    tracking.emit('completed', flightId)

    await vi.waitFor(() => expect(getStands).toHaveBeenCalledWith('EGCC'))
    await Promise.resolve()
    expect(listLastParkedByAircraft(db)).toEqual([])
  })

  it('records nothing, and asks for no stands, when the sim has gone and there is no final position', async () => {
    sim.lastTelemetry = undefined

    tracking.emit('completed', flightId)

    await Promise.resolve()
    expect(getStands).not.toHaveBeenCalled()
    expect(listLastParkedByAircraft(db)).toEqual([])
  })

  it('records nothing for a flight whose arrival is the unknown airport ZZZZ', async () => {
    const free = plannedFlight(db, 'ZZZZ')
    startFlight(db, free, 6000)
    completeFlight(db, free, 3000)
    sim.lastTelemetry = telemetry({ latitude: 53.3537, longitude: -2.2749 })

    tracking.emit('completed', free)

    await Promise.resolve()
    expect(getStands).not.toHaveBeenCalled()
    expect(listLastParkedByAircraft(db)).toEqual([])
  })

  it('records nothing for a flight the database does not have', async () => {
    sim.lastTelemetry = telemetry({ latitude: 53.3537, longitude: -2.2749 })

    tracking.emit('completed', 9999)

    await Promise.resolve()
    expect(getStands).not.toHaveBeenCalled()
  })

  it('logs a failed stand lookup and lets the completed flight stand', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    getStands.mockRejectedValue(new Error('sim not reachable'))
    sim.lastTelemetry = telemetry({ latitude: 53.3537, longitude: -2.2749 })

    tracking.emit('completed', flightId)

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    expect(warn.mock.calls[0]?.[0]).toBe('parked stand not recorded:')
    expect(String(warn.mock.calls[0]?.[1])).toContain('sim not reachable')
    expect(listLastParkedByAircraft(db)).toEqual([])
    expect(getFlight(db, flightId)?.status).toBe('completed')
    warn.mockRestore()
  })

  it('does nothing when tracking is stopped rather than completed', async () => {
    sim.lastTelemetry = telemetry({ latitude: 53.3537, longitude: -2.2749 })

    tracking.emit('stopped', flightId)

    await Promise.resolve()
    expect(getStands).not.toHaveBeenCalled()
  })
})

describe('startTracking', () => {
  let db: WingLogDb
  let sim: FakeSim
  let hub: LiveHub
  let scheduleBackgroundSync: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    db = newDb()
    sim = new FakeSim()
    hub = new LiveHub()
    scheduleBackgroundSync = vi.fn()
  })

  /** Samples of a settled aircraft at the departure stand: what AutoStartDetector waits to see. */
  function settle(): void {
    for (let i = 0; i < SETTLED_SAMPLES; i++) sim.emit('telemetry', telemetry())
  }

  it('publishes each track point, and each batch of changed points, to the live views', () => {
    const { trackingController } = startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)
    const point = { id: 1, flightId: 7, latitude: 51.47, longitude: -0.46 } as unknown as TrackPoint
    const changed = [{ ...point, id: 2 }] as unknown as TrackPoint[]

    trackingController.emit('point', point)
    trackingController.emit('pointsUpdated', changed)

    expect(hub.snapshot().trackingPoint).toBe(point)
    expect(hub.snapshot().trackingPointsUpdated).toBe(changed)
  })

  it('schedules a background sync each time a flight completes', () => {
    const { trackingController } = startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)

    trackingController.emit('completed', 3)
    trackingController.emit('completed', 4)
    expect(scheduleBackgroundSync).toHaveBeenCalledTimes(2)
  })

  // A twin hears of a write on this PC only through the same call (local-write-hints.ts): a write that does not make it is
  // not seen there until the twin syncs for another reason.
  describe('a change tracking makes to the logbook', () => {
    it('is followed by a background sync when the flight is stopped', () => {
      const { trackingController } = startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)
      const flightId = plannedFlight(db)
      trackingController.start(flightId)
      scheduleBackgroundSync.mockClear()

      trackingController.stop()

      expect(trackingController.getActive()).toBeUndefined()
      expect(scheduleBackgroundSync).toHaveBeenCalled()
    })

    it('is followed by a background sync when the flight is finished', () => {
      const { trackingController } = startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)
      const flightId = plannedFlight(db)
      trackingController.start(flightId)
      scheduleBackgroundSync.mockClear()

      trackingController.finish()

      expect(getFlight(db, flightId)?.status).toBe('completed')
      expect(scheduleBackgroundSync).toHaveBeenCalled()
    })

    it('is followed by a background sync when the flight goes active', () => {
      const { trackingController } = startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)

      trackingController.start(plannedFlight(db))

      expect(scheduleBackgroundSync).toHaveBeenCalled()
    })

    it('is followed by a background sync when the destination is changed during the flight', () => {
      const { trackingController } = startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)
      const aircraft = createAircraft(db, { registration: 'G-FREE', icaoType: 'A320' })
      const flightId = trackingController.startFree({
        aircraftId: aircraft.id,
        depIcao: 'EGLL',
        arrIcao: 'ZZZZ',
        flightNumber: null
      })
      scheduleBackgroundSync.mockClear()

      trackingController.setDestination('EGKK')

      expect(getFlight(db, flightId)?.arrIcao).toBe('EGKK')
      expect(scheduleBackgroundSync).toHaveBeenCalled()
    })
  })

  describe('auto-start', () => {
    it('starts tracking the armed flight once the sim has settled, when Settings has it on', () => {
      const { autoStartDetector, trackingController } = startTracking(
        db,
        asLiveSim(sim),
        hub,
        scheduleBackgroundSync
      )
      const flightId = plannedFlight(db)
      const started = vi.fn()
      trackingController.on('started', started)

      autoStartDetector.arm(flightId, telemetry(), 'ZZZZ')
      settle()

      expect(started).toHaveBeenCalledExactlyOnceWith(flightId)
      expect(getFlight(db, flightId)?.status).toBe('active')
    })

    it('does not start tracking when "Start tracking automatically" is off', () => {
      setTrackingSettings(db, { autoStart: false, autoFinish: true })
      const { autoStartDetector } = startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)
      const flightId = plannedFlight(db)

      autoStartDetector.arm(flightId, telemetry(), 'ZZZZ')
      settle()

      expect(getFlight(db, flightId)?.status).toBe('planned')
    })

    it('ignores a start that fails because the flight is already being tracked by hand', () => {
      const { autoStartDetector, trackingController } = startTracking(
        db,
        asLiveSim(sim),
        hub,
        scheduleBackgroundSync
      )
      const flightId = plannedFlight(db)
      trackingController.start(flightId)
      const started = vi.fn()
      trackingController.on('started', started)

      autoStartDetector.arm(flightId, telemetry(), 'ZZZZ')
      expect(settle).not.toThrow()

      expect(started).not.toHaveBeenCalled()
      expect(getFlight(db, flightId)?.status).toBe('active')
    })
  })

  describe("the sim's airfield lookup", () => {
    it('is given to tracking for a live sim, and asks the resolver with the touchdown position and heading', async () => {
      airfieldResolver.resolve.mockResolvedValue({ icao: 'VHHX' })
      startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)

      const resolveAirfield = trackingConstruction.args[0]?.[2] as (...a: number[]) => Promise<unknown>
      expect(airfieldResolver.created).toBe(1)
      await expect(resolveAirfield(22.3, 114.2, 130)).resolves.toEqual({ icao: 'VHHX' })
      expect(airfieldResolver.resolve).toHaveBeenCalledWith(22.3, 114.2, 130)
    })

    it('is left out for a replayed capture, which has no live sim to ask', () => {
      const replay = new ReplaySimConnectService({
        header: {
          scenario: 'unit-test',
          aircraftType: 'Fenix A320',
          capturedAt: '2026-09-14T00:00:00.000Z',
          notes: ''
        },
        events: [{ type: 'telemetry', tOffsetMs: 0, data: telemetry() }]
      })

      startTracking(db, replay, hub, scheduleBackgroundSync)

      expect(airfieldResolver.created).toBe(0)
      expect(trackingConstruction.args[0]?.[2]).toBeUndefined()
    })
  })

  it('tracks through the sim it was given and records into the database it was given', () => {
    const { trackingController } = startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)
    const flightId = plannedFlight(db)

    trackingController.start(flightId)

    // Started from the sim's last telemetry (10000 kg fuel) into the real database.
    expect(getFlight(db, flightId)).toMatchObject({ status: 'active', fuelOutKg: 10000 })
  })

  describe('in a normal build', () => {
    it('has no dev diagnostics, no diag.log and no flight capture', () => {
      const { trackingController, devDiagnostics } = startTracking(
        db,
        asLiveSim(sim),
        hub,
        scheduleBackgroundSync
      )
      const flightId = plannedFlight(db)
      trackingController.start(flightId)
      trackingController.emit('completed', flightId)

      expect(devDiagnostics).toBeUndefined()
      expect(diagLines.opened).toBe(0)
      expect(diagLines.written).toEqual([])
      expect(existsSync(join(electron.userDataDir, 'captures'))).toBe(false)
    })

    it('still registers the diagnostics channels, which log nothing and report no capture', () => {
      startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)
      const handlers = new Map(electron.handle.mock.calls.map(([channel, fn]) => [channel, fn]))

      handlers.get(IpcChannels.diagLog)?.({}, 'phase', 'from the renderer')

      expect(diagLines.written).toEqual([])
      expect(handlers.get(IpcChannels.captureKeepState)?.({}, 5)).toBe('none')
      expect(handlers.get(IpcChannels.captureKeep)?.({}, 5)).toBe('none')
    })
  })

  describe('in a dev build', () => {
    beforeEach(() => {
      vi.stubGlobal('__WINGLOG_DEV_BUILD__', true)
    })

    it('records the tracked flight to the captures folder and logs it, before the completion sync is scheduled', async () => {
      const events: string[] = []
      scheduleBackgroundSync.mockImplementation(() =>
        events.push(`sync after ${diagLines.written.length} diag lines`)
      )
      const { trackingController, devDiagnostics } = startTracking(
        db,
        asLiveSim(sim),
        hub,
        scheduleBackgroundSync
      )
      const flightId = plannedFlight(db)

      trackingController.start(flightId)
      expect(devDiagnostics).toBeDefined()
      // The capture file is opened asynchronously.
      await vi.waitFor(() => expect(readdirSync(join(electron.userDataDir, 'captures'))).toHaveLength(1))
      expect(diagLines.written).toEqual([
        expect.stringContaining(`[diag:capture] started for flight ${flightId}`)
      ])

      events.length = 0
      trackingController.emit('completed', flightId)

      // Diagnostics listen first: the capture is closed and logged before the sync is scheduled.
      expect(diagLines.written.at(-1)).toContain(`completed: flight ${flightId}`)
      expect(events).toEqual(['sync after 2 diag lines'])
    })

    it('lets the renderer write diag.log lines and ask about a capture, through the registered channels', async () => {
      const { trackingController } = startTracking(db, asLiveSim(sim), hub, scheduleBackgroundSync)
      const handlers = new Map(electron.handle.mock.calls.map(([channel, fn]) => [channel, fn]))
      const flightId = plannedFlight(db)
      trackingController.start(flightId)

      handlers.get(IpcChannels.diagLog)?.({}, 'map', 'style loaded')
      handlers.get(IpcChannels.diagLog)?.({}, 'not-a-category', 'ignored')

      expect(diagLines.written).toContain('[diag:map] style loaded')
      expect(diagLines.written.some((line) => line.includes('ignored'))).toBe(false)
      await vi.waitFor(() => expect(handlers.get(IpcChannels.captureKeepState)?.({}, flightId)).toBe('auto'))
      expect(handlers.get(IpcChannels.captureKeepState)?.({}, 'x')).toBe('none')
      trackingController.emit('stopped', flightId)
    })
  })
})
