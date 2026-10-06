/**
 * Replays a full capture (sim telemetry plus BeyondATC and GSX messages) through the real app on
 * one clock: the sim ticks go through ReplaySimConnectService as before, and each captured
 * incoming message reaches BeyondAtcService or GsxRemoteService through their socket seam at its
 * recorded moment (flightdeck-backend docs/plans/robustness/scenario-testing.md Part 1).
 *
 * Messages WingLog sent during the recording are not replayed: the services send their own,
 * collected on each link's `sent` for a test to check.
 */
import type { ServiceSocket, ServiceSocketCtor, ServiceSocketListeners } from '../net/service-socket'
import type { ParsedFlightFixture } from './flight-fixture'
import { ReplaySimConnectService, type ReplaySimConnectServiceOptions } from './ReplaySimConnectService'

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

/** One stream's connection, standing in for BeyondATC's or GSX's server. */
export class ReplaySocketLink {
  /** Every message the service sent, in order. */
  readonly sent: string[] = []
  /** Captured messages that arrived while the service had no open socket, as the real server's
   *  would have been missed. */
  readonly dropped: string[] = []
  /** Pass to the service's constructor in place of the real WebSocket. */
  readonly socketCtor: ServiceSocketCtor
  private socket: ReplaySocket | undefined

  constructor() {
    this.socketCtor = replaySocketCtor(this)
  }

  /**
   * Delivers one captured message to the service, if it's connected.
   *
   * @param text The message, as captured.
   */
  deliver(text: string): void {
    if (this.socket?.readyState === OPEN) this.socket.receive(text)
    else this.dropped.push(text)
  }

  /**
   * Called by a new socket.
   *
   * @param socket The service's new socket.
   */
  attach(socket: ReplaySocket): void {
    this.socket = socket
  }
}

/** A socket that connects at once and receives what its link delivers. */
class ReplaySocket implements ServiceSocket {
  readonly OPEN = OPEN
  private state = CONNECTING
  private readonly listeners: { [K in keyof ServiceSocketListeners]: ServiceSocketListeners[K][] } = {
    open: [],
    message: [],
    close: [],
    error: []
  }

  constructor(
    readonly url: string,
    private readonly link: ReplaySocketLink
  ) {
    link.attach(this)
    // Opens after the service has added its listeners, as a real connection would.
    setImmediate(() => {
      if (this.state !== CONNECTING) return
      this.state = OPEN
      for (const listener of this.listeners.open) listener()
    })
  }

  get readyState(): number {
    return this.state
  }

  addEventListener<K extends keyof ServiceSocketListeners>(type: K, listener: ServiceSocketListeners[K]): void {
    this.listeners[type].push(listener)
  }

  send(text: string): void {
    this.link.sent.push(text)
  }

  close(): void {
    if (this.state === CLOSED) return
    this.state = CLOSED
    for (const listener of this.listeners.close) listener()
  }

  receive(text: string): void {
    for (const listener of this.listeners.message) listener({ data: text })
  }
}

/**
 * The service constructs its socket with `new`; each one registers with `link` as the current one.
 *
 * @param link The stream's link.
 * @returns A socket class bound to it.
 */
function replaySocketCtor(link: ReplaySocketLink): ServiceSocketCtor {
  return class extends ReplaySocket {
    constructor(url: string) {
      super(url, link)
    }
  }
}

export interface ReplayCaptureOptions extends ReplaySimConnectServiceOptions {
  /**
   * Called before each event with the moment it was recorded (the header's `capturedAt` plus
   * its offset), in epoch ms. A test sets its fake clock here, so time-stamped state
   * (BeyondATC's transcript, the InfoBoxes' arrival time) matches the recording.
   */
  setClock?: (epochMs: number) => void
}

export interface ReplayedCapture {
  /** Hand to TrackingController in place of SimConnectService; start() plays everything. */
  sim: ReplaySimConnectService
  /** Pass `beyondAtc.socketCtor` to BeyondAtcService. */
  beyondAtc: ReplaySocketLink
  /** Pass `gsx.socketCtor` to GsxRemoteService. */
  gsx: ReplaySocketLink
}

/**
 * Sets up a capture's replay. Nothing plays until `sim.start()`; start the services first, so
 * their sockets are open for the first captured message.
 *
 * @param fixture A capture file's path, or a parsed (possibly transformed) capture.
 *
 * @param options Replay options, plus an optional clock to keep in step.
 * @returns The sim to start, and one link per stream.
 */
export function replayCapture(fixture: string | ParsedFlightFixture, options: ReplayCaptureOptions = {}): ReplayedCapture {
  const sim = new ReplaySimConnectService(fixture, options)
  const beyondAtc = new ReplaySocketLink()
  const gsx = new ReplaySocketLink()
  const startMs = Date.parse(sim.header.capturedAt)
  const { setClock } = options
  if (setClock) {
    if (Number.isNaN(startMs)) throw new Error(`Capture ${sim.header.scenario} has no valid capturedAt for the clock`)
    sim.on('offset', (offsetMs) => setClock(startMs + offsetMs))
  }
  sim.on('captured', (event) => {
    if (event.direction !== 'in') return
    ;(event.type === 'beyondatc' ? beyondAtc : gsx).deliver(event.text)
  })
  return { sim, beyondAtc, gsx }
}
