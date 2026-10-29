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
  NetworkAtc,
  NetworkControllers,
  NetworkTraffic,
  SimTraffic,
  OnlineStatus,
  TrafficLayers,
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
 * The taxi line of ATC's latest clearance, traced on the PC and drawn as it is by every screen (winglog-backend's
 * docs/plans/taxi-and-second-screen-robustness.md, stage 3): the screens no longer trace it themselves.
 */
export interface TaxiRoute {
  /** The flight shown when the clearance was taken, or null when none was. */
  flightId: number | null
  /** The airport the clearance is for ('' when it could not be told). A screen draws the line only for an airport it shows. */
  icao: string
  /** Goes up by one each time the line or the clearance changes. */
  revision: number
  /** How the line was made, or null when none could be found: nothing is drawn. */
  kind: 'exact' | 'pathfinder' | null
  /** From the aircraft to the end, [lon, lat]; empty when `kind` is null. It shortens as the aircraft taxis. */
  line: [number, number][]
  /** The clearance it is for. */
  clearance: {
    taxiways: string[]
    holdingPoint: string | null
    stand: string | null
    holdShortRunway: string | null
  }
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
  /** The chosen network's traffic near the aircraft, parsed in main (online networks, vatsim-build.md Step 1). */
  networkTraffic: NetworkTraffic
  /** The aircraft the sim lists around the pilot, read over a connection of its own while the layer draws. */
  simTraffic: SimTraffic
  /** The controllers and ATIS online at the flight's airports, from the chosen network's feed. */
  networkControllers: NetworkControllers
  /** Where the chosen network's controllers are, for the map's ATC layer: the staffed areas and airports of the whole network. */
  networkAtc: NetworkAtc
  /** Whether the pilot's own flight is on the chosen network, found in its feed (VATSIM or IVAO). */
  onlineStatus: OnlineStatus
  /** The shared traffic switches and which layers draw, decided in main in one function. */
  trafficLayers: TrafficLayers
  /** The taxi line of the latest clearance, traced on the PC; null with no clearance, or once the flight has left the ground. */
  taxiRoute: TaxiRoute | null
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
  'traffic.setNetworkOn': [on: boolean]
  'traffic.setSimOn': [on: boolean]
  'traffic.setAtcOn': [on: boolean]
}

export type LiveCommand = keyof LiveCommands
