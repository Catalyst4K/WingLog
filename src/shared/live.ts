/** The live topics main pushes while flying, and what each one carries. */

import type { Waypoint } from './route'
import type {
  BeyondAtcArrivalClearance,
  BeyondAtcConnectionStatus,
  BeyondAtcState,
  BeyondAtcStepClimbStatus,
  BeyondAtcTranscriptEntry,
  GsxRemoteCommandBar,
  GsxRemoteCommandId,
  GsxRemoteConnectionStatus,
  GsxRemoteGateInfo,
  GsxRemoteMenuState,
  GsxRemotePromptState,
  ProcedureSelection,
  GsxRemoteServiceStatus,
  SimConnectionStatus,
  SimTelemetry,
  StorageStatus,
  TrackPoint
} from './ipc'

/**
 * The planned route of the flight a second screen shows, built on the PC from the flight's plan and the SID, STAR and approach chosen
 * (winglog-backend's docs/plans/lan-sync.md). The screen draws it as it is.
 */
export interface PlannedRoute {
  flightId: number
  /** Goes up by one each time the PC publishes a different route or choice for this flight, and starts again at 1 for another flight. */
  revision: number
  /** The choice this route was built from. */
  selection: ProcedureSelection
  waypoints: Waypoint[]
}

/**
 * Every live stream the app pushes while flying, keyed by its IPC channel name
 * (winglog-backend's docs/plans/live-data-seam.md, part A). One map so the main
 * process's LiveHub, the renderer, and later a LAN client (v1.5) and a sim-PC host (v2.x)
 * all agree on what each topic carries. Payloads are plain JSON (SI units), never class
 * instances, so they survive any transport, not just Electron's structured clone.
 */
export interface LiveTopics {
  simTelemetry: SimTelemetry
  simConnectionStatus: SimConnectionStatus
  trackingPoint: TrackPoint
  trackingPointsUpdated: TrackPoint[]
  /** The SID, STAR and approach chosen for the tracked flight, from whichever screen changed it last. */
  procedureSelection: ProcedureSelection | null
  /** The planned route with that choice spliced in, from the PC, for the screens that don't build it themselves. */
  plannedRoute: PlannedRoute | null
  /** The disk's free space and whether saving is failing, for the low-disk warning on every screen. */
  storageStatus: StorageStatus
  gsxRemoteStatus: GsxRemoteConnectionStatus
  gsxRemoteServices: GsxRemoteServiceStatus[]
  gsxRemoteGate: GsxRemoteGateInfo | null
  gsxRemoteMenu: GsxRemoteMenuState
  gsxRemotePrompt: GsxRemotePromptState | null
  gsxRemoteCommandBar: GsxRemoteCommandBar
  beyondAtcStatus: BeyondAtcConnectionStatus
  beyondAtcState: BeyondAtcState
  beyondAtcTranscript: BeyondAtcTranscriptEntry[]
  beyondAtcStepClimb: BeyondAtcStepClimbStatus
  beyondAtcArrival: BeyondAtcArrivalClearance | null
}

export type LiveTopic = keyof LiveTopics

/** The latest payload of each topic that has published at least once. */
export type LiveSnapshot = Partial<LiveTopics>

/**
 * The commands a remote-capable panel can send, with their arguments (live-data-seam.md,
 * part C). Every one is validated again in the main process before it reaches BeyondATC or
 * GSX: the services check their own input, so a LAN client (v1.5) calling the same
 * methods gets the same checks.
 */
export interface LiveCommands {
  'atc.setAction': [label: string]
  'atc.setFrequency': [frequency: string]
  'atc.setFrequencyCom2': [frequency: string]
  'atc.setAutoTune': [value: boolean]
  'atc.setAutoRespond': [value: boolean]
  'atc.setStepClimb': [enabled: boolean]
  'gsx.pickMenu': [index: number]
  'gsx.search': [text: string]
  'gsx.toggleMenu': []
  'gsx.submitPrompt': [gen: number, text: string]
  'gsx.cancelPrompt': [gen: number]
  'gsx.runCommand': [id: GsxRemoteCommandId]
  'track.setProcedureSelection': [selection: ProcedureSelection]
}

export type LiveCommand = keyof LiveCommands
