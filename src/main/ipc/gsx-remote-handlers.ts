/**
 * GSX Remote Control (winglog-backend's docs/plans/gsx-remote-control.md; live protocol confirmed
 * docs/gsx-notes.md): the GsxRemoteService's lifecycle, its settings, and its IPC.
 * Native reimplementation (docs/decisions.md Option C): GsxRemoteService owns the
 * WebSocket, and the renderer only ever gets typed IPC. Off by default, opt-in per user-entered
 * host and port: GSX's Remote Client port is genuinely user-configurable, never assumed.
 *
 * GSX routines (docs/plans/gsx-service-presets.md) run here too, on the same connection: the driver steps the routine
 * runner, and its progress goes out as one more live topic.
 *
 * Channel kinds (coding-standards.md §9): the service's state and the routine's progress are **live** (published to
 * LiveHub, with a getter here for the first render), the menu, search, prompt, command and routine start/cancel channels are
 * **commands**, and the settings and the routines list, save and delete are **queries**.
 */
import type { IpcMain } from 'electron'
import { IpcChannels, type GsxRemoteSettings, type GsxRoutinesResult, type SimTelemetry } from '@shared/ipc'
import {
  BUILT_IN_ROUTINES,
  GSX_ROUTINES_MAX,
  allRoutines,
  checkRoutine,
  type GsxRoutine
} from '@shared/gsx-routines'
import type { WingLogDb } from '../db/client'
import {
  getGsxRemoteSettings,
  getGsxRoutines,
  getHiddenBuiltInRoutines,
  setGsxRemoteSettings,
  setGsxRoutines,
  setHiddenBuiltInRoutines
} from '../db/settings-repo'
import type { DevDiagnostics } from '../diagnostics/dev-diagnostics'
import { EMPTY_COMMAND_BAR, EMPTY_MENU, GsxRemoteService } from '../gsx-remote/GsxRemoteService'
import { RoutineDriver, type RoutineGsx } from '../gsx-remote/routine-driver'
import {
  dispatchCommand,
  gsxCommands,
  type CommandTable,
  type GsxCommand,
  type RoutineControl
} from '../live/commands'
import type { LiveHub } from '../live/LiveHub'
import { logger } from '../logging/logger'
import type { ServiceSocketCtor } from '../net/service-socket'

/** What GSX Remote needs. */
export interface GsxRemoteHandlerDeps {
  db: WingLogDb
  liveHub: Pick<LiveHub, 'publish'>
  /** Dev build only: records the connection in diag.log and the flight capture. */
  devDiagnostics?: Pick<DevDiagnostics, 'attachGsx'>
  /** A replayed capture's socket in e2e; the live WebSocket otherwise. */
  socketCtor?: ServiceSocketCtor
  /** The sim's latest telemetry, for a routine's guard and for stopping it when the aircraft moves. */
  telemetry?: () => SimTelemetry | undefined
  /** The shown flight's planned zero fuel weight in kg, or null when it has none. */
  plannedZfwKg?: () => number | null
}

/**
 * @param service GSX Remote.
 * @returns It as the routine driver sees it: what it shows, three menu actions, and a way to hear that anything changed.
 */
function routineGsxOf(service: GsxRemoteService): RoutineGsx {
  return {
    getStatus: () => service.getStatus(),
    getMenu: () => service.getMenu(),
    getServices: () => service.getServices(),
    getCommandBar: () => service.getCommandBar(),
    openMenuIfClosed: () => service.openMenuIfClosed(),
    closeMenuIfOpen: () => service.closeMenuIfOpen(),
    pickMenuChecked: (index, title, label) => service.pickMenuChecked(index, title, label),
    subscribe: (listener) => {
      const events = ['status', 'services', 'menu', 'commandBar'] as const
      for (const event of events) service.on(event, listener)
      return () => {
        for (const event of events) service.off(event, listener)
      }
    }
  }
}

/**
 * The pilot's own routines, with a line in the log when a stored one had to be dropped.
 *
 * @param db The database.
 * @returns The valid routines.
 */
function readOwnRoutines(db: WingLogDb): GsxRoutine[] {
  const stored = getGsxRoutines(db)
  if (stored.problem) logger.warn(`GSX routines: ${stored.problem}`)
  return stored.routines
}

/**
 * Every routine on offer: the built-ins the pilot has not deleted, then their own.
 *
 * @param db The database.
 * @param own The pilot's own routines, when the caller has just changed them.
 * @returns The list.
 */
export function listRoutines(db: WingLogDb, own: GsxRoutine[] = readOwnRoutines(db)): GsxRoutine[] {
  return allRoutines(own, getHiddenBuiltInRoutines(db))
}

/**
 * The routines queries: list, save and delete. Main checks a saved routine again whatever the renderer checked.
 *
 * @param ipcMain Electron's IPC.
 * @param db The database.
 */
function registerRoutineQueries(ipcMain: IpcMain, db: WingLogDb): void {
  ipcMain.handle(IpcChannels.gsxRoutinesList, () => listRoutines(db))
  ipcMain.handle(IpcChannels.gsxRoutinesSave, (_event, routine: unknown): GsxRoutinesResult => {
    const checked = checkRoutine(routine)
    if (!checked.ok) return { ok: false, reason: checked.reason }
    const own = readOwnRoutines(db)
    const index = own.findIndex((r) => r.id === checked.routine.id)
    if (index < 0 && own.length >= GSX_ROUTINES_MAX) {
      return { ok: false, reason: `at most ${GSX_ROUTINES_MAX} routines` }
    }
    const next =
      index < 0 ? [...own, checked.routine] : own.map((r, i) => (i === index ? checked.routine : r))
    setGsxRoutines(db, next)
    return { ok: true, routines: listRoutines(db, next) }
  })
  ipcMain.handle(IpcChannels.gsxRoutinesDelete, (_event, id: unknown): GsxRoutine[] => {
    if (BUILT_IN_ROUTINES.some((r) => r.id === id)) {
      setHiddenBuiltInRoutines(db, [...new Set([...getHiddenBuiltInRoutines(db), id as string])])
      return listRoutines(db)
    }
    const next = readOwnRoutines(db).filter((r) => r.id !== id)
    setGsxRoutines(db, next)
    return listRoutines(db, next)
  })
}

/**
 * Starts GSX Remote if it's configured, and registers its channels. Saving its settings restarts
 * the connection.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, LiveHub, diagnostics and the socket.
 * @returns `stop`, to close the connection on quit, and the GSX Remote commands, for a second screen.
 */
export function registerGsxRemoteHandlers(
  ipcMain: IpcMain,
  deps: GsxRemoteHandlerDeps
): { stop: () => void; commands: CommandTable<GsxCommand> } {
  const { db, liveHub, devDiagnostics, socketCtor } = deps
  let gsxRemoteService: GsxRemoteService | undefined
  let routineDriver: RoutineDriver | undefined
  const startGsxRemoteIfConfigured = (): void => {
    routineDriver?.dispose()
    routineDriver = undefined
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
    routineDriver = new RoutineDriver({
      gsx: routineGsxOf(gsxRemoteService),
      telemetry: deps.telemetry ?? (() => undefined),
      plannedZfwKg: deps.plannedZfwKg ?? (() => null),
      publish: (progress) => liveHub.publish('gsxRoutine', progress),
      logger
    })
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
  ipcMain.handle(IpcChannels.gsxRoutineGet, () => routineDriver?.getProgress() ?? null)
  registerRoutineQueries(ipcMain, db)
  const routineControl: RoutineControl = {
    start: (id) => {
      const routine = listRoutines(db).find((r) => r.id === id)
      if (routine) routineDriver?.start(routine)
    },
    cancel: () => routineDriver?.cancel()
  }
  const commands = gsxCommands(
    () => gsxRemoteService,
    () => routineControl
  )
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
  ipcMain.handle(IpcChannels.gsxRoutineStart, command('gsx.startRoutine'))
  ipcMain.handle(IpcChannels.gsxRoutineCancel, command('gsx.cancelRoutine'))

  return {
    stop: () => {
      routineDriver?.dispose()
      gsxRemoteService?.stop()
    },
    commands
  }
}
