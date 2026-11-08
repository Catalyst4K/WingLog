/** The second-screen server (winglog-backend's docs/plans/lan-web-viewer.md): its settings, status and paired devices. */

import type { LiveSnapshot, LiveTopic } from '../live'
import type { ProcedureSelection, TrackPoint } from './flight'

/** What the pilot sets in Settings → Second screen. */
export interface LanSettings {
  enabled: boolean
  port: number
  /** Whether another WingLog (a twin) may pair and connect; its own switch, on the Sim PC page. The server runs while either is on. */
  twinEnabled: boolean
}

/** What a paired device is: a second screen (a phone or tablet) or a twin (another WingLog). */
export type LanDeviceKind = 'screen' | 'twin'

/** A phone, tablet or another WingLog that has paired. */
export interface LanDevice {
  id: number
  kind: LanDeviceKind
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
  /** The second screen's open pairing window, if any. */
  pairing: LanPairing | null
  /** The twin's open pairing window, if any. */
  twinPairing: LanPairing | null
  devices: LanDevice[]
}

/** The flight a second screen shows: the active one, with what the map needs (the route comes from the OFP the same way the app's own map reads it). */
export interface LanFlight {
  flightId: number
  /** The flight's uuid, which is the same on every computer (ids are not): how a twin finds its own row of this flight. */
  uuid: string | null
  /** Whether this is the flight being tracked now (not only the newest one planned). */
  tracking: boolean
  depIcao: string
  arrIcao: string
  /** The flight number, such as "CPA116", when the flight has one. */
  flightNumber: string | null
  /** The scheduled arrival, UTC ISO text, for the ETA when there is no live estimate. */
  schedInUtc: string | null
  /** The aircraft's registration and ICAO type, when it is a fleet aircraft. */
  registration: string | null
  icaoType: string | null
  /** The IATA code of the aircraft's airline, for the logo beside the flight number. */
  operatorIata: string | null
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
  /** Sent to a twin only: something changed in this PC's database, so it can sync soon. */
  | { t: 'sync' }
  /** A different flight is being tracked from here on (or none): replaces the snapshot's flight and track. */
  | { t: 'flight'; flight: LanFlightSnapshot | null }
  /**
   * The answer to a device's query: the data, or `error` when it could not be answered. `busy` means it was not tried because the
   * device has too many waiting or sent too fast: asking again after `retryAfterMs` may work, and is worth doing.
   */
  | { t: 'result'; id: number; data?: unknown; error?: true; busy?: true; retryAfterMs?: number }

/** Where a client's link to the sim PC's WingLog stands (winglog-backend's docs/plans/multi-device.md, Part 2). */
export type HostLinkState =
  /** No sim PC has been paired. */
  | 'unpaired'
  | 'connecting'
  | 'connected'
  /** The link dropped; trying again. */
  | 'offline'
  /** The code was wrong, or the host's pairing window had closed. */
  | 'wrong-code'

/** What Settings and the header show of a client's link. */
export interface HostLinkStatus {
  state: HostLinkState
  /** The sim PC's `host:port`, once one has been paired or entered. */
  address: string | null
  /** The sim PC's own SimConnect state, as the host last said it; null before it has. */
  hostSim: 'connected' | 'connecting' | 'disconnected' | null
  /** Keeping this computer's fleet and logbook in step with the sim PC's. */
  sync: { state: 'idle' | 'syncing' | 'error'; lastSyncedAt: string | null }
}
