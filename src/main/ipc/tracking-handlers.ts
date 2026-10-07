/**
 * Tracking and flight IPC: starting, stopping and finishing tracking, a free flight, the flight
 * left in progress by the last session, and creating, cancelling, deleting and linking flights.
 * The tracking channels are commands to the host's TrackingController (coding-standards.md §9);
 * its live output (points, phase) goes through LiveHub, not here. The flight channels change the
 * local database, stopping or arming tracking where the change affects it.
 */
import type { IpcMain } from 'electron'
import { isRetired } from '@shared/aircraft'
import {
  IpcChannels,
  type NewFlight,
  type ProcedureSelection,
  type SimTelemetry,
  type StartFreeFlightInput
} from '@shared/ipc'
import { t } from '../i18n'
import type { WingLogDb } from '../db/client'
import { getLiveAircraftById } from '../db/aircraft-repo'
import {
  abandonAllPlanned,
  abandonFlight,
  createFlight,
  deleteFlight,
  getFlight,
  getInProgressFlight,
  linkAircraftToFlight
} from '../db/flight-repo'
import { getAircraftIdForTitle } from '../db/settings-repo'
import { getFreeFlightPrefill } from '../tracking/free-flight'
import type { AutoStartDetector } from '../tracking/AutoStartDetector'
import type { TrackingController } from '../tracking/TrackingController'

/** What the tracking and flight channels need. */
export interface TrackingHandlerDeps {
  db: WingLogDb
  trackingController: TrackingController
  autoStartDetector: Pick<AutoStartDetector, 'arm' | 'disarm'>
  /** Where the aircraft is now, for arming auto-start on a new flight. */
  getLastTelemetry: () => SimTelemetry | undefined
  /** Lets an e2e replay held until tracking starts (WINGLOG_E2E_REPLAY_HOLD) play. */
  releaseReplay: () => void
  /** Pushes a change to the cloud copy, when signed in. */
  scheduleBackgroundSync: () => void
}

/**
 * A blank/unresolved depIcao or arrIcao from the free-flight dialog becomes 'ZZZZ' — ICAO's
 * own "no location indicator assigned" code, not an invented sentinel — rather than leaving
 * either NOT NULL column null (free-flight-tracking.md's "When there's genuinely no
 * airport"). Whatever is given is trimmed/uppercased the same way AirportSearch's own
 * choices already are.
 *
 * @param icao The airport the pilot gave, if any.
 * @returns The ICAO code to store.
 */
export function normalizeFreeFlightIcao(icao: string | null): string {
  const trimmed = icao?.trim().toUpperCase()
  return trimmed || 'ZZZZ'
}

/**
 * Checks a free flight's aircraft: a fleet aircraft that isn't retired, or else the sim's own
 * registration and type, both given.
 *
 * @param db The database.
 * @param input The free-flight dialog's answers.
 * @returns The sim registration and type to store, both null for a fleet aircraft.
 * @throws When the fleet aircraft is missing, deleted or retired, or the sim's registration or type is blank.
 */
function freeFlightAircraft(
  db: WingLogDb,
  input: StartFreeFlightInput
): { simRegistration: string | null; simIcaoType: string | null } {
  if (input.aircraftId != null) {
    const aircraft = getLiveAircraftById(db, input.aircraftId)
    if (!aircraft || isRetired(aircraft)) {
      throw new Error(t('errors.aircraftNotFoundOrRetired', { id: input.aircraftId }))
    }
    return { simRegistration: null, simIcaoType: null }
  }
  const simRegistration = input.simRegistration?.trim() || ''
  const simIcaoType = input.simIcaoType?.trim().toUpperCase() || ''
  if (!simRegistration || !simIcaoType) throw new Error(t('errors.registrationAndTypeRequired'))
  return { simRegistration, simIcaoType }
}

/**
 * Registers the tracking channels, including the prompt for the flight the last session left in
 * progress.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, tracking, auto-start, the replay hold and the background sync.
 */
export function registerTrackingHandlers(ipcMain: IpcMain, deps: TrackingHandlerDeps): void {
  const { db, trackingController, autoStartDetector, releaseReplay, scheduleBackgroundSync } = deps

  ipcMain.handle(IpcChannels.trackingStart, (_event, flightId: number) => {
    autoStartDetector.disarm()
    trackingController.start(flightId)
    releaseReplay()
  })
  ipcMain.handle(IpcChannels.trackingStartFree, (_event, input: StartFreeFlightInput) => {
    const { simRegistration, simIcaoType } = freeFlightAircraft(db, input)
    autoStartDetector.disarm()
    const flightId = trackingController.startFree({
      aircraftId: input.aircraftId,
      simRegistration,
      simIcaoType,
      depIcao: normalizeFreeFlightIcao(input.depIcao),
      arrIcao: normalizeFreeFlightIcao(input.arrIcao),
      flightNumber: input.flightNumber?.trim() || null
    })
    releaseReplay()
    scheduleBackgroundSync()
    return flightId
  })
  ipcMain.handle(
    IpcChannels.trackingGetFreeFlightPrefill,
    (
      _event,
      input: { atcId: string; atcModel: string; title: string; latitude: number; longitude: number }
    ) => getFreeFlightPrefill((title) => getAircraftIdForTitle(db, title), input)
  )
  ipcMain.handle(IpcChannels.trackingStop, () => trackingController.stop())
  ipcMain.handle(IpcChannels.trackingFinish, () => trackingController.finish())
  ipcMain.handle(IpcChannels.trackingGetActive, () => trackingController.getActive() ?? null)
  ipcMain.handle(IpcChannels.trackingSetDestination, (_event, icao: unknown) => {
    if (icao !== null && typeof icao !== 'string') throw new Error(t('errors.invalidDestination'))
    trackingController.setDestination(icao)
  })
  ipcMain.handle(IpcChannels.trackingSetDeparture, (_event, icao: unknown) => {
    if (icao !== null && typeof icao !== 'string') throw new Error(t('errors.invalidDeparture'))
    trackingController.setDeparture(icao)
  })
  ipcMain.handle(IpcChannels.trackingSetProcedureSelection, (_event, selection: ProcedureSelection) =>
    trackingController.setProcedureSelection(selection)
  )

  // The one flight left "in progress" (planned or already active) when the previous
  // process quit or crashed — its DB row (OFP, route, everything Dispatch/Track need)
  // was never at risk, only TrackingController's in-memory phase-detection state, which
  // only exists at all once a flight reaches 'active'. Left as a choice for the user
  // (not auto-resumed/auto-continued) rather than assumed, since only the user can
  // judge whether it's still relevant — captured once here, at startup, and cleared the
  // moment the renderer answers the prompt this drives. trackingController.resume()
  // itself already no-ops for a merely-'planned' flight (nothing was ever tracking it),
  // so "resume" is safe to call unconditionally regardless of which status this is.
  let orphanedFlight = getInProgressFlight(db)
  ipcMain.handle(IpcChannels.trackingGetOrphanedFlight, () => orphanedFlight ?? null)
  ipcMain.handle(IpcChannels.trackingResumeOrphaned, (_event, flightId: number) => {
    if (orphanedFlight?.id !== flightId) return
    trackingController.resume(flightId)
    orphanedFlight = undefined
  })
  ipcMain.handle(IpcChannels.trackingDiscardOrphaned, (_event, flightId: number) => {
    if (orphanedFlight?.id !== flightId) return
    abandonFlight(db, flightId)
    orphanedFlight = undefined
    scheduleBackgroundSync()
  })
}

/**
 * Registers the flight channels: create, cancel, delete, and link an aircraft.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, tracking, auto-start, the current telemetry and the background sync.
 */
export function registerFlightHandlers(ipcMain: IpcMain, deps: TrackingHandlerDeps): void {
  const { db, trackingController, autoStartDetector, getLastTelemetry, scheduleBackgroundSync } = deps

  // Only one flight is ever meant to be "in progress" (planned or active) at once —
  // pressing "Fly" on a new plan replaces whatever was already planned or being tracked,
  // rather than letting flights pile up alongside each other.
  ipcMain.handle(IpcChannels.flightCreate, (_event, input: NewFlight) => {
    if (!getLiveAircraftById(db, input.aircraftId)) {
      throw new Error(t('errors.aircraftNotFoundOrRetired', { id: input.aircraftId }))
    }
    trackingController.stop()
    abandonAllPlanned(db)
    const flight = createFlight(db, input)
    autoStartDetector.arm(flight.id, getLastTelemetry(), flight.depIcao)
    scheduleBackgroundSync()
    return flight
  })
  ipcMain.handle(IpcChannels.flightCancel, (_event, id: number) => {
    abandonFlight(db, id)
    autoStartDetector.disarm()
    scheduleBackgroundSync()
  })
  ipcMain.handle(IpcChannels.flightDelete, (_event, id: number) => {
    // Refuse to delete the flight currently being tracked out from under
    // TrackingController — stop() (same path flightCancel uses) first if it's the one.
    if (trackingController.getActive()?.flightId === id) trackingController.stop()
    deleteFlight(db, id)
    scheduleBackgroundSync()
  })
  ipcMain.handle(IpcChannels.flightLinkAircraft, (_event, flightId: number, aircraftId: number) => {
    const existingFlight = getFlight(db, flightId)
    if (!existingFlight) throw new Error(`Flight ${flightId} not found`)
    if (existingFlight.aircraftId != null) {
      throw new Error(t('errors.flightAlreadyHasLinkedAircraft', { flightId }))
    }
    const aircraftRow = getLiveAircraftById(db, aircraftId)
    if (!aircraftRow || isRetired(aircraftRow)) {
      throw new Error(t('errors.aircraftNotFoundOrRetired', { id: aircraftId }))
    }
    const updated = linkAircraftToFlight(db, flightId, aircraftId)
    scheduleBackgroundSync()
    return updated
  })
}
