/**
 * BeyondATC integration (winglog-backend's docs/plans/beyondatc-integration.md; live protocol
 * confirmed docs/beyondatc-notes.md, 2026-09-25): the BeyondAtcService's lifecycle and settings,
 * the arrival clearance shown on the BeyondATC tab, WingLog's own auto step climb, and their IPC.
 * Off by default, opt-in per user-entered host. Unlike GSX Remote, the port is fixed
 * (BeyondAtcService's own BEYONDATC_PORT), so there's no port to validate here.
 *
 * Channel kinds (coding-standards.md §9): the service's state, transcript, arrival clearance and
 * step-climb status are **live** (published to LiveHub, with a getter here for the first render),
 * the action, frequency, auto-tune, auto-respond and step-climb setters are **commands**, and the
 * settings are **queries**.
 */
import type { IpcMain } from 'electron'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { IpcChannels, type BeyondAtcSettings, type NavdataProcedureOption } from '@shared/ipc'
import { ArrivalClearanceTracker } from '../beyondatc/arrival-clearance'
import { BeyondAtcService } from '../beyondatc/BeyondAtcService'
import { StepClimbController } from '../beyondatc/step-climb'
import type { WingLogDb } from '../db/client'
import { getFlight } from '../db/flight-repo'
import { getBeyondAtcSettings, setBeyondAtcSettings } from '../db/settings-repo'
import type { DevDiagnostics } from '../diagnostics/dev-diagnostics'
import type { LiveHub } from '../live/LiveHub'
import type { ServiceSocketCtor } from '../net/service-socket'
import type { SimConnectSource } from '../sim/SimConnectSource'
import type { TrackingController } from '../tracking/TrackingController'

/** What BeyondATC needs. */
export interface BeyondAtcHandlerDeps {
  db: WingLogDb
  liveHub: Pick<LiveHub, 'publish'>
  /** The active flight (its arrival airport and OFP), and each point's phase. */
  trackingController: Pick<TrackingController, 'on' | 'getActive'>
  /** Telemetry, for step climb. */
  sim: Pick<SimConnectSource, 'on'>
  /** The arrival airport's approaches, from navdata. */
  listApproaches: (icao: string) => NavdataProcedureOption[]
  /** Dev build only: records the connection in diag.log and the flight capture. */
  devDiagnostics?: Pick<DevDiagnostics, 'attachBeyondAtc'>
  /** A replayed capture's socket in e2e; the live WebSocket otherwise. */
  socketCtor?: ServiceSocketCtor
  /** The e2e fake server's port; BeyondATC's own otherwise. */
  port?: number
}

/**
 * Starts BeyondATC if it's configured, wires the arrival clearance and step climb, and registers
 * their channels. Saving the settings restarts the connection.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, LiveHub, tracking, telemetry, navdata, diagnostics and the socket.
 * @returns `stop`, to close the connection on quit.
 */
export function registerBeyondAtcHandlers(
  ipcMain: IpcMain,
  deps: BeyondAtcHandlerDeps
): { stop: () => void } {
  const { db, liveHub, trackingController, devDiagnostics, socketCtor, port } = deps
  let beyondAtcService: BeyondAtcService | undefined
  // ATC's arrival clearance for the BeyondATC tab's info card, until touchdown.
  const arrivalClearance = new ArrivalClearanceTracker({
    getArrivalIcao: () => {
      const active = trackingController.getActive()
      return (
        (active && getFlight(db, active.flightId)?.arrIcao) ||
        beyondAtcService?.getState().progress?.to ||
        null
      )
    },
    listApproaches: (icao) => deps.listApproaches(icao)
  })
  arrivalClearance.on('clearance', (clearance) => liveHub.publish('beyondAtcArrival', clearance))
  trackingController.on('point', (point) => arrivalClearance.onPhase(point.phase))
  ipcMain.handle(IpcChannels.beyondAtcGetArrival, () => arrivalClearance.getClearance())

  const startBeyondAtcIfConfigured = (): void => {
    beyondAtcService?.stop()
    beyondAtcService = undefined
    const settings = getBeyondAtcSettings(db)
    if (!settings.enabled) return
    beyondAtcService = new BeyondAtcService(settings.host, port, socketCtor)
    devDiagnostics?.attachBeyondAtc(beyondAtcService)
    beyondAtcService.on('status', (status) => liveHub.publish('beyondAtcStatus', status))
    beyondAtcService.on('state', (state) => {
      liveHub.publish('beyondAtcState', state)
      arrivalClearance.onInfoBoxes(state.infoBoxes)
    })
    beyondAtcService.on('transcript', (transcript) => liveHub.publish('beyondAtcTranscript', transcript))
    beyondAtcService.start()
  }
  startBeyondAtcIfConfigured()

  ipcMain.handle(IpcChannels.settingsGetBeyondAtc, () => getBeyondAtcSettings(db))
  ipcMain.handle(IpcChannels.settingsSetBeyondAtc, (_event, settings: BeyondAtcSettings) => {
    setBeyondAtcSettings(db, settings)
    startBeyondAtcIfConfigured()
  })
  registerSessionHandlers(ipcMain, () => beyondAtcService)
  registerStepClimb(ipcMain, deps, () => beyondAtcService)

  return { stop: () => beyondAtcService?.stop() }
}

/**
 * Registers the channels that read or drive the current BeyondATC session, if there is one.
 *
 * @param ipcMain Electron's IPC.
 * @param session The current session; undefined while BeyondATC is off.
 */
function registerSessionHandlers(ipcMain: IpcMain, session: () => BeyondAtcService | undefined): void {
  ipcMain.handle(
    IpcChannels.beyondAtcGetStatus,
    () => session()?.getStatus() ?? { state: 'disconnected', lastError: null }
  )
  ipcMain.handle(IpcChannels.beyondAtcGetState, () => session()?.getState() ?? EMPTY_BEYONDATC_STATE)
  ipcMain.handle(IpcChannels.beyondAtcGetTranscript, () => session()?.getTranscript() ?? [])
  ipcMain.handle(IpcChannels.beyondAtcSetAction, (_event, label: unknown) => session()?.setAction(label))
  ipcMain.handle(IpcChannels.beyondAtcSetFrequency, (_event, frequency: unknown) =>
    session()?.setFrequency(frequency)
  )
  ipcMain.handle(IpcChannels.beyondAtcSetFrequencyCom2, (_event, frequency: unknown) =>
    session()?.setFrequencyCom2(frequency)
  )
  ipcMain.handle(IpcChannels.beyondAtcSetAutoTune, (_event, value: unknown) => session()?.setAutoTune(value))
  ipcMain.handle(IpcChannels.beyondAtcSetAutoRespond, (_event, value: unknown) =>
    session()?.setAutoRespond(value)
  )
}

/**
 * WingLog's own auto step climb (winglog-backend's docs/plans/beyondatc-auto-step-climb.md): asks
 * BeyondATC for each new cruise level. Reads the current session lazily, since saving the
 * settings replaces it. Off every launch.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, LiveHub, tracking and telemetry.
 * @param session The current BeyondATC session; undefined while BeyondATC is off.
 */
function registerStepClimb(
  ipcMain: IpcMain,
  { db, liveHub, trackingController, sim }: BeyondAtcHandlerDeps,
  session: () => BeyondAtcService | undefined
): void {
  const stepClimb = new StepClimbController({
    getSession: session,
    getActive: () => trackingController.getActive(),
    getOfpJson: (flightId) => getFlight(db, flightId)?.ofpJson ?? null
  })
  stepClimb.on('status', (status) => liveHub.publish('beyondAtcStepClimb', status))
  sim.on('telemetry', (telemetry) => stepClimb.onTelemetry(telemetry))
  ipcMain.handle(IpcChannels.beyondAtcGetStepClimb, () => stepClimb.getStatus())
  ipcMain.handle(IpcChannels.beyondAtcSetStepClimb, (_event, enabled: unknown) => {
    if (typeof enabled === 'boolean') stepClimb.setEnabled(enabled)
  })
}
