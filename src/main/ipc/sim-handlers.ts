/**
 * Sim connection IPC and the dev build's diagnostics. Telemetry and the connection status are
 * **live** (coding-standards.md §9): published to LiveHub, with a status getter for the first
 * render. The diagnostics channels are **commands** that write diag.log or keep a flight's
 * capture, and do nothing outside the dev build.
 */
import type { IpcMain } from 'electron'
import { IpcChannels, type SimConnectionStatus, type SimTelemetry } from '@shared/ipc'
import { isDiagCategory, MAX_LINE_CHARS, type Diag } from '../diagnostics/diag'
import { isFlightId, type FlightCapture } from '../diagnostics/flight-capture'
import type { LiveHub } from '../live/LiveHub'

/** The sim connection, live or replayed. */
export interface SimStatusSource {
  on(event: 'telemetry', listener: (telemetry: SimTelemetry) => void): unknown
  on(event: 'status', listener: (status: SimConnectionStatus) => void): unknown
  getStatus(): SimConnectionStatus
}

/**
 * Publishes the sim's telemetry and connection status, and registers the status getter.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The sim connection and LiveHub.
 */
export function registerSimHandlers(
  ipcMain: IpcMain,
  { sim, liveHub }: { sim: SimStatusSource; liveHub: Pick<LiveHub, 'publish'> }
): void {
  ipcMain.handle(IpcChannels.simConnectionStatusGet, () => sim.getStatus())
  sim.on('telemetry', (telemetry) => liveHub.publish('simTelemetry', telemetry))
  sim.on('status', (status) => liveHub.publish('simConnectionStatus', status))
}

/**
 * Registers the dev build's diagnostics channels: a renderer line for diag.log, and keeping a
 * flight's capture.
 *
 * @param ipcMain Electron's IPC.
 * @param deps diag.log's writer (a no-op outside the dev build) and the flight capture (absent
 *   outside it).
 */
export function registerDiagnosticsHandlers(
  ipcMain: IpcMain,
  { diag, flightCapture }: { diag: Diag; flightCapture?: Pick<FlightCapture, 'keep' | 'keepState'> }
): void {
  ipcMain.handle(IpcChannels.diagLog, (_event, category: unknown, message: unknown) => {
    if (!isDiagCategory(category) || typeof message !== 'string') return
    diag(category, message.slice(0, MAX_LINE_CHARS))
  })
  ipcMain.handle(IpcChannels.captureKeepState, (_event, flightId: unknown) =>
    flightCapture && isFlightId(flightId) ? flightCapture.keepState(flightId) : 'none'
  )
  ipcMain.handle(IpcChannels.captureKeep, (_event, flightId: unknown) =>
    flightCapture && isFlightId(flightId) ? flightCapture.keep(flightId) : 'none'
  )
}
