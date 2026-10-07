/**
 * The kind of every IPC channel (coding-standards.md §9), so the host/UI line the v1.5 LAN viewer
 * and the v2 split need is in code and checked by the compiler, not only said in module headers.
 *
 * - **live:** the host's state, published through LiveHub (and the getter a view calls for its
 *   first render).
 * - **command:** something a client asks the host to do: a tracking, GSX Remote or BeyondATC
 *   action, or a log entry.
 * - **query:** a read or write of this device's own database, settings or caches, or a lookup.
 * - **local:** only makes sense on this machine: a file dialog, a page opened outside the app, a
 *   SimBrief window.
 */
import type { IpcChannels } from './ipc-channels'

/** What a channel is for. */
export type ChannelKind = 'live' | 'command' | 'query' | 'local'

/** The channels that are not queries; every other channel is one. */
const NOT_QUERIES = {
  live: [
    'simTelemetry',
    'simConnectionStatus',
    'simConnectionStatusGet',
    'trackingPoint',
    'trackingPointsUpdated',
    'trackingGetActive',
    'updatesStatus',
    'gsxRemoteStatus',
    'gsxRemoteServices',
    'gsxRemoteGate',
    'gsxRemoteMenu',
    'gsxRemotePrompt',
    'gsxRemoteCommandBar',
    'gsxRemoteGetStatus',
    'gsxRemoteGetServices',
    'gsxRemoteGetGateInfo',
    'gsxRemoteGetMenu',
    'gsxRemoteGetPrompt',
    'gsxRemoteGetCommandBar',
    'beyondAtcStatus',
    'beyondAtcState',
    'beyondAtcTranscript',
    'beyondAtcStepClimb',
    'beyondAtcArrival',
    'beyondAtcGetStatus',
    'beyondAtcGetState',
    'beyondAtcGetTranscript',
    'beyondAtcGetStepClimb',
    'beyondAtcGetArrival'
  ],
  command: [
    'trackingStart',
    'trackingStartFree',
    'trackingStop',
    'trackingFinish',
    'trackingSetProcedureSelection',
    'trackingSetDestination',
    'trackingSetDeparture',
    'trackingResumeOrphaned',
    'trackingDiscardOrphaned',
    'gsxRemotePickMenu',
    'gsxRemoteSearch',
    'gsxRemoteToggleMenu',
    'gsxRemoteSubmitPrompt',
    'gsxRemoteCancelPrompt',
    'gsxRemoteRunCommand',
    'beyondAtcSetAction',
    'beyondAtcSetFrequency',
    'beyondAtcSetFrequencyCom2',
    'beyondAtcSetAutoTune',
    'beyondAtcSetAutoRespond',
    'beyondAtcSetStepClimb',
    'diagLog',
    'captureKeep',
    'appLogRendererError'
  ],
  local: [
    'appOpenGithub',
    'appOpenManual',
    'updatesOpenRelease',
    'gsxBrowseFolder',
    'gsxOpenReceipt',
    'aircraftImport',
    'aircraftExport',
    'logbookImportCsv',
    'logbookImportJson',
    'logbookExport',
    'logbookOpenOfpPdf',
    'dispatchOpenSimBrief',
    'dispatchOpenSimBriefAirframes',
    'dispatchOpenOfpPdf',
    'dispatchGenerateOfp',
    'dispatchLoginSimbrief',
    'dispatchLogoutSimbrief',
    'simbriefCreateCustomAirframe'
  ]
} as const satisfies Record<Exclude<ChannelKind, 'query'>, readonly (keyof typeof IpcChannels)[]>

/**
 * A channel's kind.
 *
 * @param channel The channel's key in `IpcChannels`.
 * @returns Its kind; anything not listed above is a query.
 */
export function channelKind(channel: keyof typeof IpcChannels): ChannelKind {
  for (const kind of ['live', 'command', 'local'] as const) {
    if ((NOT_QUERIES[kind] as readonly string[]).includes(channel)) return kind
  }
  return 'query'
}
