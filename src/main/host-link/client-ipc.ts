/**
 * What a client's renderer calls instead of the services it does not run (winglog-backend's docs/plans/multi-device.md, Part 2). The
 * link republishes the host's topics into this computer's hub; here the matching "current value" queries read that hub, the commands a
 * phone may send are forwarded to the host, and Settings pairs, forgets and shows the link.
 */
import type { IpcMain } from 'electron'
import type { LiveCommand, LiveTopic } from '@shared/live'
import { IpcChannels } from '@shared/ipc'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import type { HostLinkStatus, OnlineNetwork, OnlineNetworkSettings, TrackingSettings } from '@shared/ipc'
import { isCertificatePin } from '@shared/host-address'
import { logger } from '../logging/logger'
import type { HandledChannels } from '../client-mode'
import { asOnlineNetwork } from '../online/prefile-url'
import type { LiveHub } from '../live/LiveHub'
import { parseProcedureSelection } from '../live/commands'
import type { ProcedureSelectionStore } from '../procedures/ProcedureSelectionStore'
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

/**
 * @param value Anything.
 * @returns Whether it is a plain object whose fields can be read.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * @param network The network the sim PC has chosen, or null for none or when it cannot be asked.
 * @returns The online settings as a client reads them: the network, and nothing else of the sim PC's (no member numbers).
 */
function clientOnlineSettings(network: OnlineNetwork | null): OnlineNetworkSettings {
  return { network, vatsimCid: null, ivaoVid: null, keepBeyondAtcOnline: false, simTrafficButton: true }
}

/**
 * @param value What the sim PC answered to `settings.tracking`.
 * @returns Its two switches, or null when the answer is not two true/false values.
 */
function simPcTracking(value: unknown): TrackingSettings | null {
  if (typeof value !== 'object' || value === null) return null
  const { autoStart, autoFinish } = value as Record<string, unknown>
  return typeof autoStart === 'boolean' && typeof autoFinish === 'boolean' ? { autoStart, autoFinish } : null
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

/**
 * The airport data a client's screens read through the app's own channels (Procedures' runways and procedures, the taxi chart, stands): the
 * channel, the lookup the sim PC answers it with (the same ones the phone page uses), and what it reads as while the sim PC cannot be asked (undefined: the
 * error goes to the screen, which then does not remember an empty answer for the session, as the taxi chart would).
 * The data is the sim's, cached on the sim PC; a client has no sim to fill a cache of its own.
 */
export const NAVDATA_LOOKUPS: readonly (readonly [channel: string, lookup: string, fallback: unknown])[] = [
  [IpcChannels.navdataListRunways, 'navdata.listRunways', []],
  [IpcChannels.navdataListSids, 'navdata.listSids', []],
  [IpcChannels.navdataListStars, 'navdata.listStars', []],
  [IpcChannels.navdataListApproaches, 'navdata.listApproaches', []],
  [IpcChannels.navdataGetProcedureWaypoints, 'navdata.procedureWaypoints', []],
  [IpcChannels.navdataHasTaxiNetwork, 'taxi.has', undefined],
  [IpcChannels.navdataGetTaxiNetwork, 'taxi.get', undefined],
  [IpcChannels.navdataGetStands, 'stands', []]
]

/**
 * The ATIS a client shows (the weather panel's network ATIS and the BeyondATC page's), asked of the sim PC, which fetches them: the
 * channel, the lookup, and what it reads as while the sim PC cannot be asked (nothing to show).
 */
export const ATIS_LOOKUPS: readonly (readonly [channel: string, lookup: string, fallback: unknown])[] = [
  [IpcChannels.onlineAtisGet, 'online.atis', { network: null, airports: [] }],
  [IpcChannels.beyondAtcGetAtis, 'beyondatc.atis', { state: 'unavailable', airports: [] }]
]

/** Refreshing airport data needs the sim, so on a client it does nothing: the sim PC fetches the shown flight's airports itself. */
const NAVDATA_REFRESHES: readonly string[] = [
  IpcChannels.navdataRefreshAirport,
  IpcChannels.navdataRefreshTaxiNetwork
]

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
 * @param value A pin from the renderer.
 * @returns The pin, or null when there is none (a typed pairing).
 * @throws When it is there and is not a certificate pin: it is refused, never read as "no pin", which would check nothing.
 */
function checkedPin(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (!isCertificatePin(value)) throw new Error('Invalid certificate pin')
  return value
}

/**
 * Registers the channels a client answers itself.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The link to the host and this computer's hub.
 * @param deps.link The link to the sim PC's WingLog.
 * @param deps.hub The hub the link republishes into.
 * @param deps.handled The channels registered so far. A client takes over the ones it answers: one a local service registered is replaced,
 *   and one that service registers later is left out (a second handler for a channel throws, so the order must not matter).
 * @param deps.ownSelection This computer's own procedure store, and whether the sim PC is flying a flight: the window's choice for that flight
 *   goes to the sim PC (the phone's command), which owns it. Left out, the choice channels stay as they were.
 */
export function registerHostLinkHandlers(
  ipcMain: IpcMain,
  {
    link,
    hub,
    handled,
    ownSelection
  }: {
    link: HostLink
    hub: LiveHub
    handled: HandledChannels
    ownSelection?: {
      store: Pick<ProcedureSelectionStore, 'set' | 'current'>
      hostFlying: () => boolean
    }
  }
): void {
  ipcMain.handle(IpcChannels.hostLinkGetStatus, (): HostLinkStatus => link.getStatus())
  ipcMain.handle(
    IpcChannels.hostLinkPair,
    (_event, address: unknown, code: unknown, pin: unknown): HostLinkStatus => {
      link.pair(shortText(address), shortText(code), checkedPin(pin))
      return link.getStatus()
    }
  )
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
    // A channel answered twice would lose its handler (the second is left out as a local one would be), so it is refused where it is written.
    if (handled.claimed.has(channel))
      throw new Error(`The sim PC's answer for '${channel}' is registered twice`)
    // Electron refuses a second handler for a channel, so one a local service already answers is replaced: a client's answer is the sim PC's.
    if (handled.has(channel)) {
      ipcMain.removeHandler(channel)
      taken.push(channel)
    }
    ipcMain.handle(channel, (_event, ...args: unknown[]) => reply(...args))
    // From here on a local service that registers the channel is left out (client-mode.ts), whichever of them starts first.
    handled.claimed.add(channel)
  }
  // Which network to file on is the sim PC's choice, read here and never changed from here. Nothing but its name is asked for: the member
  // numbers stay on the sim PC, and the rest read as they do on a client with nothing chosen.
  answer(IpcChannels.settingsGetOnlineNetwork, () =>
    link.query('settings.onlineNetwork').then(
      (value) => clientOnlineSettings(asOnlineNetwork(isRecord(value) ? value.network : null)),
      () => clientOnlineSettings(null)
    )
  )
  // Automatic start and finish are the sim PC's settings, shown here read only (a twin may not change the sim PC's settings). Null while
  // the sim PC cannot be asked, or answers with something else.
  answer(IpcChannels.settingsGetTracking, () =>
    link.query('settings.tracking').then(simPcTracking, () => null)
  )
  // A map view, not a sim-PC setting: this computer's own choice of "Whole network" asks the sim PC for the set (it has no feed of its own).
  answer(IpcChannels.networkTrafficWholeGet, () => link.query('online.trafficWhole'))
  for (const [command, channel] of Object.entries(FORWARDED_COMMANDS)) {
    if (command === 'gsx.startRoutine') continue
    answer(channel, (...args) => link.command(command, args))
  }
  // The routines are rows that sync, so a routine made or edited here a moment ago may not have reached the sim PC: start it after a sync.
  answer(IpcChannels.gsxRoutineStart, (...args) => link.commandAfterSync('gsx.startRoutine', args))
  if (ownSelection) {
    // Not in FORWARDED_COMMANDS: a flight planned here and not yet flying keeps its choice on this computer's own row.
    answer(IpcChannels.trackingSetProcedureSelection, (selection) => {
      const chosen = parseProcedureSelection(selection)
      if (ownSelection.hostFlying()) link.command('track.setProcedureSelection', [chosen])
      else ownSelection.store.set(chosen, 'window')
    })
    answer(
      IpcChannels.trackingGetProcedureSelection,
      () => ownSelection.store.current() ?? hub.snapshot().procedureSelection ?? null
    )
  }
  for (const [topic, channel] of Object.entries(TOPIC_GETTERS)) {
    answer(channel, () => hub.snapshot()[topic as LiveTopic] ?? TOPIC_DEFAULTS[topic as LiveTopic])
  }
  for (const [channel, lookup, fallback] of NAVDATA_LOOKUPS) {
    answer(channel, (...args) =>
      link.query(lookup, ...args).catch((error: unknown) => {
        if (fallback === undefined) throw error
        return fallback
      })
    )
  }
  for (const [channel, lookup, fallback] of ATIS_LOOKUPS) {
    answer(channel, (...args) => link.query(lookup, ...args).catch(() => fallback))
  }
  for (const channel of NAVDATA_REFRESHES) answer(channel, () => undefined)
  answer(IpcChannels.navdataHasAirport, (icao) =>
    link.query('navdata.listRunways', icao).then(
      (runways) => Array.isArray(runways) && runways.length > 0,
      () => false
    )
  )
  if (taken.length > 0) logger.info('[host-link] took over from the local services:', taken.join(', '))
}
