import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels, type Flight, type SimTelemetry, type StartFreeFlightInput } from '@shared/ipc'
import { createAircraft, deleteAircraft, retireAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { createFlight, createFreeFlight, getFlight, getInProgressFlight } from '../db/flight-repo'
import type { TrackingController } from '../tracking/TrackingController'
import { fakeIpc } from './fake-ipc'
import {
  normalizeFreeFlightIcao,
  registerFlightHandlers,
  registerTrackingHandlers,
  type TrackingHandlerDeps
} from './tracking-handlers'

const FREE_FLIGHT: StartFreeFlightInput = {
  aircraftId: null,
  simRegistration: ' g-eupt ',
  simIcaoType: ' a319 ',
  depIcao: ' egll',
  arrIcao: null,
  flightNumber: ' BA1 '
}

/** A TrackingController that records what it's asked to do. */
function fakeTracking(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    start: vi.fn(),
    startFree: vi.fn(() => 42),
    stop: vi.fn(),
    finish: vi.fn(),
    getActive: vi.fn(() => undefined),
    setDestination: vi.fn(),
    setDeparture: vi.fn(),
    setProcedureSelection: vi.fn(),
    resume: vi.fn()
  }
}

describe('normalizeFreeFlightIcao', () => {
  it("trims and upper-cases, and stores ICAO's 'ZZZZ' for no airport", () => {
    expect(normalizeFreeFlightIcao(' egll ')).toBe('EGLL')
    expect(normalizeFreeFlightIcao('  ')).toBe('ZZZZ')
    expect(normalizeFreeFlightIcao(null)).toBe('ZZZZ')
  })
})

describe('tracking and flight IPC handlers', () => {
  let db: WingLogDb
  let tracking: ReturnType<typeof fakeTracking>
  let deps: TrackingHandlerDeps
  const autoStartDetector = { arm: vi.fn(), disarm: vi.fn() }
  const releaseReplay = vi.fn()
  const sync = vi.fn()
  const telemetry = { latitude: 51.47, longitude: -0.45 } as SimTelemetry

  /** Registers both areas against the current database, as at startup. */
  function register(): ReturnType<typeof fakeIpc>['invoke'] {
    const ipc = fakeIpc()
    registerTrackingHandlers(ipc.ipcMain, deps)
    registerFlightHandlers(ipc.ipcMain, deps)
    return ipc.invoke
  }

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    vi.clearAllMocks()
    tracking = fakeTracking()
    deps = {
      db,
      trackingController: tracking as unknown as TrackingController,
      autoStartDetector,
      getLastTelemetry: () => telemetry,
      releaseReplay,
      scheduleBackgroundSync: sync
    }
  })

  it('starts tracking a planned flight: disarms auto-start and releases a held replay', () => {
    register()(IpcChannels.trackingStart, 7)
    expect(autoStartDetector.disarm).toHaveBeenCalled()
    expect(tracking.start).toHaveBeenCalledWith(7)
    expect(releaseReplay).toHaveBeenCalled()
  })

  it("starts a free flight in the sim's aircraft, tidying what the pilot typed", () => {
    expect(register()(IpcChannels.trackingStartFree, FREE_FLIGHT)).toBe(42)
    expect(tracking.startFree).toHaveBeenCalledWith({
      aircraftId: null,
      simRegistration: 'g-eupt',
      simIcaoType: 'A319',
      depIcao: 'EGLL',
      arrIcao: 'ZZZZ',
      flightNumber: 'BA1'
    })
    expect(releaseReplay).toHaveBeenCalled()
    expect(sync).toHaveBeenCalled()
  })

  it('starts a free flight in a fleet aircraft, but not a retired or missing one', () => {
    const invoke = register()
    const aircraft = createAircraft(db, { registration: 'G-EUPT', icaoType: 'A319' })
    invoke(IpcChannels.trackingStartFree, { ...FREE_FLIGHT, aircraftId: aircraft.id })
    expect(tracking.startFree).toHaveBeenCalledWith(
      expect.objectContaining({ aircraftId: aircraft.id, simRegistration: null, simIcaoType: null })
    )
    retireAircraft(db, aircraft.id)
    expect(() => invoke(IpcChannels.trackingStartFree, { ...FREE_FLIGHT, aircraftId: aircraft.id })).toThrow()
    expect(() => invoke(IpcChannels.trackingStartFree, { ...FREE_FLIGHT, aircraftId: 999 })).toThrow()
    expect(() => invoke(IpcChannels.trackingStartFree, { ...FREE_FLIGHT, simRegistration: ' ' })).toThrow()
    expect(() => invoke(IpcChannels.trackingStartFree, { ...FREE_FLIGHT, simIcaoType: null })).toThrow()
    expect(tracking.startFree).toHaveBeenCalledTimes(1)
  })

  it('suggests a free flight from the sim aircraft and where it is', () => {
    const prefill = register()(IpcChannels.trackingGetFreeFlightPrefill, {
      atcId: 'G-EUPT',
      atcModel: 'A319',
      title: 'Airbus A319 British Airways',
      latitude: 51.4706,
      longitude: -0.4619
    })
    expect(prefill).toMatchObject({ suggestedDepIcao: 'EGLL', rememberedAircraftId: null })
  })

  it('passes stop, finish, the active flight and the procedures to the controller', () => {
    const invoke = register()
    invoke(IpcChannels.trackingStop)
    invoke(IpcChannels.trackingFinish)
    expect(invoke(IpcChannels.trackingGetActive)).toBeNull()
    invoke(IpcChannels.trackingSetProcedureSelection, { sid: 'OCEAN2A' })
    expect(tracking.stop).toHaveBeenCalled()
    expect(tracking.finish).toHaveBeenCalled()
    expect(tracking.setProcedureSelection).toHaveBeenCalledWith({ sid: 'OCEAN2A' })
  })

  it('takes a departure or destination ICAO, or null, and rejects anything else', () => {
    const invoke = register()
    invoke(IpcChannels.trackingSetDestination, 'ZJSY')
    invoke(IpcChannels.trackingSetDeparture, null)
    expect(tracking.setDestination).toHaveBeenCalledWith('ZJSY')
    expect(tracking.setDeparture).toHaveBeenCalledWith(null)
    expect(() => invoke(IpcChannels.trackingSetDestination, 42)).toThrow()
    expect(() => invoke(IpcChannels.trackingSetDeparture, { icao: 'EGLL' })).toThrow()
  })

  it('offers the flight the last session left in progress, once, to resume or discard', () => {
    const aircraft = createAircraft(db, { registration: 'B-HSL', icaoType: 'A320' })
    const left = createFlight(db, { aircraftId: aircraft.id, depIcao: 'VHHH', arrIcao: 'ZJSY' })
    const invoke = register()
    expect((invoke(IpcChannels.trackingGetOrphanedFlight) as Flight).id).toBe(left.id)

    invoke(IpcChannels.trackingResumeOrphaned, left.id + 1)
    invoke(IpcChannels.trackingDiscardOrphaned, left.id + 1)
    expect(tracking.resume).not.toHaveBeenCalled()
    expect(getInProgressFlight(db)?.id).toBe(left.id)

    invoke(IpcChannels.trackingDiscardOrphaned, left.id)
    expect(getInProgressFlight(db)).toBeUndefined()
    expect(sync).toHaveBeenCalled()
    expect(invoke(IpcChannels.trackingGetOrphanedFlight)).toBeNull()
    invoke(IpcChannels.trackingResumeOrphaned, left.id)
    expect(tracking.resume).not.toHaveBeenCalled()
  })

  it('resumes the flight left in progress', () => {
    const aircraft = createAircraft(db, { registration: 'B-HSL', icaoType: 'A320' })
    const left = createFlight(db, { aircraftId: aircraft.id, depIcao: 'VHHH', arrIcao: 'ZJSY' })
    const invoke = register()
    invoke(IpcChannels.trackingResumeOrphaned, left.id)
    expect(tracking.resume).toHaveBeenCalledWith(left.id)
    expect(invoke(IpcChannels.trackingGetOrphanedFlight)).toBeNull()
  })

  it('replaces whatever was planned with a new flight, and arms auto-start where the aircraft is', () => {
    const invoke = register()
    const aircraft = createAircraft(db, { registration: 'B-HSL', icaoType: 'A320' })
    const first = invoke(IpcChannels.flightCreate, {
      aircraftId: aircraft.id,
      depIcao: 'VHHH',
      arrIcao: 'ZJSY'
    }) as Flight
    const second = invoke(IpcChannels.flightCreate, {
      aircraftId: aircraft.id,
      depIcao: 'VHHH',
      arrIcao: 'RCTP'
    }) as Flight
    expect(tracking.stop).toHaveBeenCalledTimes(2)
    expect(getFlight(db, first.id)?.status).toBe('abandoned')
    expect(getInProgressFlight(db)?.id).toBe(second.id)
    expect(autoStartDetector.arm).toHaveBeenLastCalledWith(second.id, telemetry, 'VHHH')
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('cancels a planned flight, and stops tracking before deleting the tracked one', () => {
    const invoke = register()
    const aircraft = createAircraft(db, { registration: 'B-HSL', icaoType: 'A320' })
    const planned = createFlight(db, { aircraftId: aircraft.id, depIcao: 'VHHH', arrIcao: 'ZJSY' })
    invoke(IpcChannels.flightCancel, planned.id)
    expect(getInProgressFlight(db)).toBeUndefined()
    expect(autoStartDetector.disarm).toHaveBeenCalled()

    invoke(IpcChannels.flightDelete, planned.id)
    expect(tracking.stop).not.toHaveBeenCalled()
    const tracked = createFlight(db, { aircraftId: aircraft.id, depIcao: 'VHHH', arrIcao: 'ZJSY' })
    tracking.getActive.mockReturnValue({ flightId: tracked.id })
    invoke(IpcChannels.flightDelete, tracked.id)
    expect(tracking.stop).toHaveBeenCalledTimes(1)
    expect(getInProgressFlight(db)).toBeUndefined()
    expect(sync).toHaveBeenCalledTimes(3)
  })

  it('links a fleet aircraft to a free flight flown without one, only once', () => {
    const invoke = register()
    const aircraft = createAircraft(db, { registration: 'G-EUPT', icaoType: 'A319' })
    const retired = createAircraft(db, { registration: 'G-EUPA', icaoType: 'A319' })
    retireAircraft(db, retired.id)
    const free = createFreeFlight(db, {
      aircraftId: null,
      simRegistration: 'G-EUPT',
      simIcaoType: 'A319',
      depIcao: 'EGLL',
      arrIcao: 'EGCC',
      flightNumber: null,
      fuelOutKg: 5000
    })
    expect(() => invoke(IpcChannels.flightLinkAircraft, 999, aircraft.id)).toThrow('Flight 999 not found')
    expect(() => invoke(IpcChannels.flightLinkAircraft, free.id, retired.id)).toThrow()
    expect(() => invoke(IpcChannels.flightLinkAircraft, free.id, 999)).toThrow()
    expect((invoke(IpcChannels.flightLinkAircraft, free.id, aircraft.id) as Flight).aircraftId).toBe(
      aircraft.id
    )
    expect(() => invoke(IpcChannels.flightLinkAircraft, free.id, aircraft.id)).toThrow()
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('refuses a retired aircraft for a new flight, the same as a deleted one', () => {
    const invoke = register()
    const retired = createAircraft(db, { registration: 'G-OLD', icaoType: 'A320' })
    retireAircraft(db, retired.id)
    expect(() =>
      invoke(IpcChannels.flightCreate, { aircraftId: retired.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
    ).toThrow('not found or retired')
    expect(tracking.stop).not.toHaveBeenCalled()
    expect(getInProgressFlight(db)).toBeUndefined()
    expect(sync).not.toHaveBeenCalled()
  })

  it('refuses a deleted fleet aircraft for a free flight, a new flight, or a link', () => {
    const invoke = register()
    const gone = createAircraft(db, { registration: 'G-GONE', icaoType: 'A320' })
    deleteAircraft(db, gone.id)
    const free = createFreeFlight(db, {
      aircraftId: null,
      simRegistration: 'G-EUPT',
      simIcaoType: 'A319',
      depIcao: 'EGLL',
      arrIcao: 'EGCC',
      flightNumber: null,
      fuelOutKg: 5000
    })
    expect(() => invoke(IpcChannels.trackingStartFree, { ...FREE_FLIGHT, aircraftId: gone.id })).toThrow()
    expect(() =>
      invoke(IpcChannels.flightCreate, { aircraftId: gone.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
    ).toThrow()
    expect(() => invoke(IpcChannels.flightLinkAircraft, free.id, gone.id)).toThrow()
    expect(() =>
      invoke(IpcChannels.flightCreate, { aircraftId: 999, depIcao: 'EGLL', arrIcao: 'EGCC' })
    ).toThrow()
    expect(tracking.startFree).not.toHaveBeenCalled()
    expect(tracking.stop).not.toHaveBeenCalled()
    expect(getFlight(db, free.id)?.aircraftId).toBeNull()
    expect(sync).not.toHaveBeenCalled()
  })
})
