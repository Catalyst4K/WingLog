/**
 * What a client's renderer calls instead of the services it does not run (winglog-backend's docs/plans/multi-device.md, Part 2). The
 * link republishes the host's topics into this computer's hub; here the matching "current value" queries read that hub, the commands a
 * phone may send are forwarded to the host, and Settings pairs, forgets and shows the link.
 */
import type { IpcMain } from 'electron'
import type { LiveCommand, LiveTopic } from '@shared/live'
import { IpcChannels } from '@shared/ipc'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import type { HostLinkStatus } from '@shared/ipc'
import { logger } from '../logging/logger'
import type { LiveHub } from '../live/LiveHub'
import type { HostLink } from './HostLink'

/** The IPC channel each live command goes out on from the renderer, which a client sends to the host instead of acting on. */
export const FORWARDED_COMMANDS: Partial<Record<LiveCommand, string>> = {
  'atc.setAction': IpcChannels.beyondAtcSetAction,
  'atc.setFrequency': IpcChannels.beyondAtcSetFrequency,
  'atc.setFrequencyCom2': IpcChannels.beyondAtcSetFrequencyCom2,
  'atc.setAutoTune': IpcChannels.beyondAtcSetAutoTune,
  'atc.setAutoRespond': IpcChannels.beyondAtcSetAutoRespond,
  'atc.setStepClimb': IpcChannels.beyondAtcSetStepClimb,
  'gsx.pickMenu': IpcChannels.gsxRemotePickMenu,
  'gsx.search': IpcChannels.gsxRemoteSearch,
  'gsx.toggleMenu': IpcChannels.gsxRemoteToggleMenu,
  'gsx.submitPrompt': IpcChannels.gsxRemoteSubmitPrompt,
  'gsx.cancelPrompt': IpcChannels.gsxRemoteCancelPrompt,
  'gsx.runCommand': IpcChannels.gsxRemoteRunCommand,
  'gsx.startRoutine': IpcChannels.gsxRoutineStart,
  'gsx.cancelRoutine': IpcChannels.gsxRoutineCancel,
  'traffic.setNetworkOn': IpcChannels.trafficSetNetworkOn,
  'traffic.setSimOn': IpcChannels.trafficSetSimOn,
  'traffic.setAtcOn': IpcChannels.trafficSetAtcOn
}

/** The "current value" query each topic has, answered from the hub (what the host last said). */
export const TOPIC_GETTERS: Partial<Record<LiveTopic, string>> = {
  taxiRoute: IpcChannels.taxiRouteGet,
  plannedRoute: IpcChannels.plannedRouteGet,
  networkTraffic: IpcChannels.networkTrafficGet,
  simTraffic: IpcChannels.simTrafficGet,
  trafficLayers: IpcChannels.trafficLayersGet,
  onlineStatus: IpcChannels.onlineStatusGet,
  networkControllers: IpcChannels.networkControllersGet,
  networkAtc: IpcChannels.networkAtcGet,
  gsxRemoteStatus: IpcChannels.gsxRemoteGetStatus,
  gsxRemoteServices: IpcChannels.gsxRemoteGetServices,
  gsxRemoteGate: IpcChannels.gsxRemoteGetGateInfo,
  gsxRemoteMenu: IpcChannels.gsxRemoteGetMenu,
  gsxRemotePrompt: IpcChannels.gsxRemoteGetPrompt,
  gsxRemoteCommandBar: IpcChannels.gsxRemoteGetCommandBar,
  gsxRoutine: IpcChannels.gsxRoutineGet,
  beyondAtcStatus: IpcChannels.beyondAtcGetStatus,
  beyondAtcState: IpcChannels.beyondAtcGetState,
  beyondAtcTranscript: IpcChannels.beyondAtcGetTranscript,
  beyondAtcStepClimb: IpcChannels.beyondAtcGetStepClimb,
  beyondAtcArrival: IpcChannels.beyondAtcGetArrival
}

/**
 * What a topic reads as before the host has said anything: the empty value its own service starts with, so a screen that reads it directly
 * (Settings' lights, the clearance prompt) never meets undefined.
 */
export const TOPIC_DEFAULTS: Partial<Record<LiveTopic, unknown>> = {
  gsxRemoteStatus: { state: 'disconnected', lastError: null },
  beyondAtcStatus: { state: 'disconnected', lastError: null },
  beyondAtcState: EMPTY_BEYONDATC_STATE,
  gsxRemoteServices: [],
  beyondAtcTranscript: [],
  gsxRemoteGate: null,
  gsxRemotePrompt: null,
  gsxRoutine: null,
  beyondAtcArrival: null,
  taxiRoute: null,
  plannedRoute: null
}

/** What an add-on reads as while the sim PC cannot be asked: switched off. */
const ADD_ON_OFF = {
  gsxRemote: { enabled: false, host: '127.0.0.1', port: null },
  beyondAtc: { enabled: false, host: '127.0.0.1' }
}

/** Longest text taken for an address or a code, so a pasted page cannot become a connection string. */
const MAX_FIELD_CHARS = 200

/**
 * @param value A value from the renderer.
 * @returns The text, or an empty string when it is not a reasonably short string.
 */
function shortText(value: unknown): string {
  return typeof value === 'string' && value.length <= MAX_FIELD_CHARS ? value : ''
}

/**
 * Registers the channels a client answers itself.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The link to the host and this computer's hub.
 * @param deps.link The link to the sim PC's WingLog.
 * @param deps.hub The hub the link republishes into.
 * @param deps.handled The channels something else already answers: a client takes them over (a second handler for a channel throws).
 */
export function registerHostLinkHandlers(
  ipcMain: IpcMain,
  { link, hub, handled }: { link: HostLink; hub: LiveHub; handled: ReadonlySet<string> }
): void {
  ipcMain.handle(IpcChannels.hostLinkGetStatus, (): HostLinkStatus => link.getStatus())
  ipcMain.handle(IpcChannels.hostLinkPair, (_event, address: unknown, code: unknown): HostLinkStatus => {
    link.pair(shortText(address), shortText(code))
    return link.getStatus()
  })
  ipcMain.handle(IpcChannels.hostLinkForget, () => link.forget())
  // The add-ons run on the sim PC, so whether they are on is its setting: a client asks it, and reads them as off while it cannot.
  ipcMain.handle(IpcChannels.settingsGetGsxRemote, () =>
    link.query('settings.gsxRemote').catch(() => ADD_ON_OFF.gsxRemote)
  )
  ipcMain.handle(IpcChannels.settingsGetBeyondAtc, () =>
    link.query('settings.beyondAtc').catch(() => ADD_ON_OFF.beyondAtc)
  )
  const taken: string[] = []
  const answer = (channel: string, reply: (...args: unknown[]) => unknown): void => {
    // Electron refuses a second handler for a channel, so one a local service already answers is replaced: a client's answer is the sim PC's.
    if (handled.has(channel)) {
      ipcMain.removeHandler(channel)
      taken.push(channel)
    }
    ipcMain.handle(channel, (_event, ...args: unknown[]) => reply(...args))
  }
  for (const [command, channel] of Object.entries(FORWARDED_COMMANDS)) {
    answer(channel, (...args) => link.command(command, args))
  }
  for (const [topic, channel] of Object.entries(TOPIC_GETTERS)) {
    answer(channel, () => hub.snapshot()[topic as LiveTopic] ?? TOPIC_DEFAULTS[topic as LiveTopic])
  }
  if (taken.length > 0) logger.info('[host-link] took over from the local services:', taken.join(', '))
}
