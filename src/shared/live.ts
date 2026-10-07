/** The live topics main pushes while flying, and what each one carries. */

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
  GsxRemoteServiceStatus,
  SimConnectionStatus,
  SimTelemetry,
  TrackPoint
} from './ipc'

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
}

export type LiveCommand = keyof LiveCommands

