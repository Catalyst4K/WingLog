/** The second-screen server (winglog-backend's docs/plans/lan-web-viewer.md): its settings, status and paired devices. */

import type { LiveSnapshot, LiveTopic } from '../live'
import type { ProcedureSelection, TrackPoint } from './flight'

/** What the pilot sets in Settings → Second screen. */
export interface LanSettings {
  enabled: boolean
  port: number
}

/** A phone or tablet that has paired. */
export interface LanDevice {
  id: number
  name: string
  createdAt: string
  lastSeenAt: string | null
}

/** An open pairing window: the code to type on the device. */
export interface LanPairing {
  code: string
  /** Milliseconds since the epoch. */
  expiresAt: number
}

/** Why the server isn't listening although it is switched on. */
export type LanProblem = 'no-adapter' | 'port-in-use' | 'failed'

/** The server's state as Settings shows it. */
export interface LanStatus {
  settings: LanSettings
  listening: boolean
  /** The address a device opens, when listening. */
  url: string | null
  problem: LanProblem | null
  /** Devices with an open connection right now. */
  connections: number
  pairing: LanPairing | null
  devices: LanDevice[]
}

/** The flight a second screen shows: the active one, with what the map needs (the route comes from the OFP the same way the app's own map reads it). */
export interface LanFlight {
  flightId: number
  depIcao: string
  arrIcao: string
  /** The flight number, such as "CPA116", when the flight has one. */
  flightNumber: string | null
  /** The scheduled arrival, UTC ISO text, for the ETA when there is no live estimate. */
  schedInUtc: string | null
  /** The aircraft's registration and ICAO type, when it is a fleet aircraft. */
  registration: string | null
  icaoType: string | null
  ofpJson: string | null
  /** The SID, STAR and approach chosen so far: the window's own choice if it has made one, else the flight's saved one. */
  selection: ProcedureSelection
}

/** The active flight with its recorded track, sent to a device when it connects. */
export interface LanFlightSnapshot {
  flight: LanFlight
  trackPoints: TrackPoint[]
}

/** What the server sends a device. */
export type LanServerMessage =
  | { t: 'paired'; token: string }
  | { t: 'denied' }
  /** Sent every few seconds so a device can tell a quiet PC from a frozen or vanished one. */
  | { t: 'hb' }
  /** A message was refused. `retryAfterMs` is set when the device sent too many and should wait that long before sending again. */
  | { t: 'error'; message: string; retryAfterMs?: number }
  | { t: 'snapshot'; topics: LiveSnapshot; flight: LanFlightSnapshot | null }
  | { t: 'topic'; name: LiveTopic; payload: unknown }
  /** A different flight is being tracked from here on (or none): replaces the snapshot's flight and track. */
  | { t: 'flight'; flight: LanFlightSnapshot | null }
  /**
   * The answer to a device's query: the data, or `error` when it could not be answered. `busy` means it was not tried because the
   * device has too many waiting or sent too fast: asking again after `retryAfterMs` may work, and is worth doing.
   */
  | { t: 'result'; id: number; data?: unknown; error?: true; busy?: true; retryAfterMs?: number }
