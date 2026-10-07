/**
 * GSX Remote Control (winglog-backend's docs/plans/gsx-remote-control.md; live protocol confirmed
 * docs/gsx-notes.md, 2026-09-21): the GsxRemoteService's lifecycle, its settings, and its IPC.
 * Native reimplementation (docs/decisions.md, 2026-09-21 Option C): GsxRemoteService owns the
 * WebSocket, and the renderer only ever gets typed IPC. Off by default, opt-in per user-entered
 * host and port: GSX's Remote Client port is genuinely user-configurable, never assumed.
 *
 * Channel kinds (coding-standards.md §9): the service's state is **live** (published to LiveHub,
 * with a getter here for the first render), the menu, search, prompt and command channels are
 * **commands**, and the settings are **queries**.
 */
import type { IpcMain } from 'electron'
import { IpcChannels, type GsxRemoteSettings } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { getGsxRemoteSettings, setGsxRemoteSettings } from '../db/settings-repo'
import type { DevDiagnostics } from '../diagnostics/dev-diagnostics'
import { EMPTY_COMMAND_BAR, EMPTY_MENU, GsxRemoteService } from '../gsx-remote/GsxRemoteService'
import { dispatchCommand, gsxCommands, type GsxCommand } from '../live/commands'
import type { LiveHub } from '../live/LiveHub'
import type { ServiceSocketCtor } from '../net/service-socket'

/** What GSX Remote needs. */
export interface GsxRemoteHandlerDeps {
  db: WingLogDb
  liveHub: Pick<LiveHub, 'publish'>
  /** Dev build only: records the connection in diag.log and the flight capture. */
  devDiagnostics?: Pick<DevDiagnostics, 'attachGsx'>
  /** A replayed capture's socket in e2e; the live WebSocket otherwise. */
  socketCtor?: ServiceSocketCtor
}

/**
 * Starts GSX Remote if it's configured, and registers its channels. Saving its settings restarts
 * the connection.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, LiveHub, diagnostics and the socket.
 * @returns `stop`, to close the connection on quit.
 */
export function registerGsxRemoteHandlers(
  ipcMain: IpcMain,
  deps: GsxRemoteHandlerDeps
): { stop: () => void } {
  const { db, liveHub, devDiagnostics, socketCtor } = deps
  let gsxRemoteService: GsxRemoteService | undefined
  const startGsxRemoteIfConfigured = (): void => {
    gsxRemoteService?.stop()
    gsxRemoteService = undefined
    const settings = getGsxRemoteSettings(db)
    if (!settings.enabled || !settings.port) return
    gsxRemoteService = new GsxRemoteService(settings.host, settings.port, socketCtor)
    devDiagnostics?.attachGsx(gsxRemoteService)
    gsxRemoteService.on('status', (status) => liveHub.publish('gsxRemoteStatus', status))
    gsxRemoteService.on('services', (services) => liveHub.publish('gsxRemoteServices', services))
    gsxRemoteService.on('gate', (gate) => liveHub.publish('gsxRemoteGate', gate))
    gsxRemoteService.on('menu', (menu) => liveHub.publish('gsxRemoteMenu', menu))
    gsxRemoteService.on('prompt', (prompt) => liveHub.publish('gsxRemotePrompt', prompt))
    gsxRemoteService.on('commandBar', (commandBar) => liveHub.publish('gsxRemoteCommandBar', commandBar))
    gsxRemoteService.start()
  }
  startGsxRemoteIfConfigured()

  ipcMain.handle(IpcChannels.settingsGetGsxRemote, () => getGsxRemoteSettings(db))
  ipcMain.handle(IpcChannels.settingsSetGsxRemote, (_event, settings: GsxRemoteSettings) => {
    setGsxRemoteSettings(db, settings)
    startGsxRemoteIfConfigured()
  })
  ipcMain.handle(
    IpcChannels.gsxRemoteGetStatus,
    () => gsxRemoteService?.getStatus() ?? { state: 'disconnected', lastError: null }
  )
  ipcMain.handle(IpcChannels.gsxRemoteGetServices, () => gsxRemoteService?.getServices() ?? [])
  ipcMain.handle(IpcChannels.gsxRemoteGetGateInfo, () => gsxRemoteService?.getGateInfo() ?? null)
  ipcMain.handle(IpcChannels.gsxRemoteGetMenu, () => gsxRemoteService?.getMenu() ?? EMPTY_MENU)
  ipcMain.handle(IpcChannels.gsxRemoteGetPrompt, () => gsxRemoteService?.getPrompt() ?? null)
  ipcMain.handle(
    IpcChannels.gsxRemoteGetCommandBar,
    () => gsxRemoteService?.getCommandBar() ?? EMPTY_COMMAND_BAR
  )
  const commands = gsxCommands(() => gsxRemoteService)
  const command =
    (name: GsxCommand) =>
    (_event: unknown, ...args: unknown[]) =>
      dispatchCommand(commands, name, args)
  ipcMain.handle(IpcChannels.gsxRemotePickMenu, command('gsx.pickMenu'))
  ipcMain.handle(IpcChannels.gsxRemoteSearch, command('gsx.search'))
  ipcMain.handle(IpcChannels.gsxRemoteToggleMenu, command('gsx.toggleMenu'))
  ipcMain.handle(IpcChannels.gsxRemoteSubmitPrompt, command('gsx.submitPrompt'))
  ipcMain.handle(IpcChannels.gsxRemoteCancelPrompt, command('gsx.cancelPrompt'))
  ipcMain.handle(IpcChannels.gsxRemoteRunCommand, command('gsx.runCommand'))

  return { stop: () => gsxRemoteService?.stop() }
}
