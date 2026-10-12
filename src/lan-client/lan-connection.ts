/**
 * The second-screen page's link to the PC (winglog-backend's docs/plans/lan-web-viewer.md): pairs once with the code the PC shows, keeps
 * the token it hands back, and from then on says hello with it, receives the snapshot and each live topic, and reconnects when the link
 * drops. Holds no UI; the page reads `state`, `flight` and the topics from it.
 */

import type { LiveSnapshot, LiveTopic, LiveTopics } from '@shared/live'
import type { LanFlightSnapshot, LanServerMessage, TrackPoint } from '@shared/ipc'

/** Where the link stands. */
export type LanLinkState =
  | 'starting'
  /** No token yet, or the PC no longer knows it: the person types the code. */
  | 'needs-pairing'
  /** The code was wrong, or the pairing window had closed. */
  | 'wrong-code'
  | 'connected'
  /** The link dropped; trying again. */
  | 'offline'

/** The part of a browser WebSocket the link uses. */
export interface LinkSocket {
  readonly readyState: number
  send(text: string): void
  close(): void
  // Handlers are typed `never` so a browser WebSocket (whose handlers take an Event) fits as well as the test double.
  onopen: ((event: never) => void) | null
  onmessage: ((event: never) => void) | null
  onclose: ((event: never) => void) | null
}

/** Where the token is kept: the browser's local storage, or a stand-in in tests. */
export interface TokenStore {
  get(): string | null
  set(token: string): void
  clear(): void
}

/** How long a lookup waits for its answer, in milliseconds. */
const QUERY_TIMEOUT_MS = 60_000

/** A connected link that has heard nothing for this long is treated as dead: the PC sends a heartbeat every 10 s. */
const STALE_MS = 35_000
/** How often the link checks it has heard from the PC. */
const STALE_CHECK_MS = 5_000

/** Longest wait between reconnect attempts, in milliseconds. */
const MAX_BACKOFF_MS = 10_000

type StateListener = (state: LanLinkState) => void

/** The link to the PC: pairing, the live topics and the active flight's track. */
export class LanConnection {
  private socket: LinkSocket | null = null
  private current: LanLinkState = 'starting'
  private backoff = 1000
  private retry: ReturnType<typeof setTimeout> | null = null
  private pairingCode: string | null = null
  private stopped = false
  private flightSnapshot: LanFlightSnapshot | null = null
  private trackPoints: TrackPoint[] = []
  private readonly trackListeners = new Set<() => void>()
  private nextQueryId = 1
  private lastHeard = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private readonly pendingQueries = new Map<
    number,
    { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly topics: Partial<LiveTopics> = {}
  private readonly stateListeners = new Set<StateListener>()
  private readonly topicListeners = new Map<LiveTopic, Set<(payload: never) => void>>()
  private readonly flightListeners = new Set<(flight: LanFlightSnapshot | null) => void>()

  /**
   * @param url The WebSocket address (`ws://host:port/live`).
   * @param store Where the device token is kept.
   * @param createSocket Opens a socket (the browser's WebSocket in the page).
   * @param deviceName The label the PC shows for this device when it pairs.
   */
  constructor(
    private readonly url: string,
    private readonly store: TokenStore,
    private readonly createSocket: (url: string) => LinkSocket,
    private readonly deviceName: string
  ) {}

  /** @returns Where the link stands. */
  get state(): LanLinkState {
    return this.current
  }

  /** @returns The active flight and its track, or null when the PC isn't tracking one. */
  get flight(): LanFlightSnapshot | null {
    return this.flightSnapshot
  }

  /**
   * Asks the PC for read-only data the map needs (the airfield list, a taxi chart, stands).
   *
   * @param name The lookup's name.
   * @param arg Its argument, such as an airport code.
   * @returns The answer; rejects when the link is down, the PC refuses, or nothing comes back within a minute.
   */
  query(name: string, arg?: unknown): Promise<unknown> {
    const socket = this.socket
    if (!socket || this.current !== 'connected') return Promise.reject(new Error('Not connected'))
    const id = this.nextQueryId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingQueries.delete(id)
        reject(new Error('The PC did not answer'))
      }, QUERY_TIMEOUT_MS)
      this.pendingQueries.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ t: 'query', id, name, arg }))
    })
  }

  /** @returns The active flight's recorded track so far: the snapshot's points, then each new one; a new array whenever it changes. */
  get track(): TrackPoint[] {
    return this.trackPoints
  }

  /**
   * @param listener Called whenever the track changes.
   * @returns A function that stops it.
   */
  onTrack(listener: () => void): () => void {
    this.trackListeners.add(listener)
    return () => this.trackListeners.delete(listener)
  }

  /**
   * @param topic A live topic.
   * @returns Its latest value, or undefined if the PC has not sent one.
   */
  latest<T extends LiveTopic>(topic: T): LiveTopics[T] | undefined {
    return this.topics[topic]
  }

  /** Connects with the stored token, or waits for a code when there is none. */
  start(): void {
    this.stopped = false
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkHeard(), STALE_CHECK_MS)
    if (this.store.get()) this.connect()
    else this.setState('needs-pairing')
  }

  /**
   * Reconnects now. A phone that was locked or switched to another app often comes back with a socket the OS killed without telling the
   * page, so it looks connected and is not: the page calls this when it becomes visible again, or the network returns.
   */
  resume(): void {
    if (this.stopped || this.pairingCode !== null || !this.store.get()) return
    if (this.current === 'needs-pairing' || this.current === 'wrong-code') return
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.backoff = 1000
    this.connect()
  }

  /** Closes the link and stops reconnecting. */
  stop(): void {
    this.stopped = true
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.socket?.close()
    this.socket = null
  }

  /**
   * Pairs with the code the PC shows.
   *
   * @param code What the person typed.
   */
  pair(code: string): void {
    this.pairingCode = code.trim()
    this.connect()
  }

  /**
   * @param listener Called whenever the state changes.
   * @returns A function that stops it.
   */
  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /**
   * @param listener Called when the snapshot replaces the flight.
   * @returns A function that stops it.
   */
  onFlight(listener: (flight: LanFlightSnapshot | null) => void): () => void {
    this.flightListeners.add(listener)
    return () => this.flightListeners.delete(listener)
  }

  /**
   * @param topic A live topic.
   * @param listener Called with each new value of it.
   * @returns A function that stops it.
   */
  subscribe<T extends LiveTopic>(topic: T, listener: (payload: LiveTopics[T]) => void): () => void {
    const set = this.topicListeners.get(topic) ?? new Set()
    set.add(listener as (payload: never) => void)
    this.topicListeners.set(topic, set)
    return () => set.delete(listener as (payload: never) => void)
  }

  private setState(state: LanLinkState): void {
    if (state === this.current) return
    this.current = state
    for (const listener of this.stateListeners) listener(state)
  }

  private connect(): void {
    // Forget the old socket before closing it, so its close is not mistaken for the link dropping.
    const old = this.socket
    this.socket = null
    old?.close()
    const socket = this.createSocket(this.url)
    this.socket = socket
    socket.onopen = () => {
      if (this.pairingCode !== null) {
        socket.send(JSON.stringify({ t: 'pair', code: this.pairingCode, name: this.deviceName }))
      } else {
        socket.send(JSON.stringify({ t: 'hello', token: this.store.get() }))
      }
    }
    socket.onmessage = (event: { data: unknown }) =>
      this.handle(typeof event.data === 'string' ? event.data : '')
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.failPendingQueries()
      if (this.stopped) return
      if (this.current === 'connected' || this.current === 'offline' || this.current === 'starting') {
        this.setState('offline')
        this.scheduleRetry()
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = null
      if (!this.stopped && this.store.get()) this.connect()
    }, this.backoff)
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
  }

  /** A link that says it is connected but has heard nothing for a while is dead (the PC froze or went away): say so and reconnect. */
  private checkHeard(): void {
    if (this.current !== 'connected' || Date.now() - this.lastHeard < STALE_MS) return
    this.setState('offline')
    this.resume()
  }

  private handle(text: string): void {
    const message = parseServerMessage(text)
    if (!message) return
    this.lastHeard = Date.now()
    if (message.t === 'paired') {
      this.store.set(message.token)
      this.pairingCode = null
    } else if (message.t === 'denied') {
      this.handleDenied()
    } else if (message.t === 'snapshot') {
      this.handleSnapshot(message.topics, message.flight)
    } else if (message.t === 'result') {
      this.answerQuery(message)
    } else if (message.t === 'flight') {
      this.replaceFlight(message.flight)
    } else if (message.t === 'topic') {
      ;(this.topics as Record<string, unknown>)[message.name] = message.payload
      this.followTrack(message.name, message.payload)
      this.emit(message.name, message.payload)
    }
  }

  /**
   * @param message The PC's answer to a lookup.
   */
  private answerQuery(message: { id: number; data?: unknown; error?: true }): void {
    const waiting = this.pendingQueries.get(message.id)
    if (!waiting) return
    clearTimeout(waiting.timer)
    this.pendingQueries.delete(message.id)
    if (message.error) waiting.reject(new Error('The PC could not answer'))
    else waiting.resolve(message.data)
  }

  /** Fails every lookup still waiting: the link they were asked over has gone. */
  private failPendingQueries(): void {
    for (const waiting of this.pendingQueries.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('Not connected'))
    }
    this.pendingQueries.clear()
  }

  /** The PC refused: a wrong code while pairing, otherwise a token it no longer knows (revoked). */
  private handleDenied(): void {
    if (this.pairingCode !== null) {
      this.pairingCode = null
      this.setState('wrong-code')
    } else {
      this.store.clear()
      this.setState('needs-pairing')
    }
  }

  /**
   * The full picture sent after hello or pairing: replaces every topic and the flight, and the link is live.
   *
   * @param topics Every topic the PC has published.
   * @param flight The flight being tracked, if any.
   */
  private handleSnapshot(topics: LiveSnapshot, flight: LanFlightSnapshot | null): void {
    this.backoff = 1000
    for (const key of Object.keys(this.topics)) delete this.topics[key as LiveTopic]
    Object.assign(this.topics, topics)
    this.setState('connected')
    this.replaceFlight(flight)
    for (const [topic, value] of Object.entries(topics)) this.emit(topic as LiveTopic, value)
  }

  /**
   * @param flight The flight now being tracked, or null.
   */
  private replaceFlight(flight: LanFlightSnapshot | null): void {
    this.flightSnapshot = flight
    this.setTrack(flight?.trackPoints ?? [])
    for (const listener of this.flightListeners) listener(flight)
  }

  private setTrack(points: TrackPoint[]): void {
    this.trackPoints = points
    for (const listener of this.trackListeners) listener()
  }

  /**
   * Keeps the track current from the two topics that carry it: a new point is added, and a cleanup pass's changed points (it sends only those) are patched in by id.
   *
   * @param topic The topic that arrived.
   * @param payload Its value.
   */
  private followTrack(topic: LiveTopic, payload: unknown): void {
    if (topic === 'trackingPointsUpdated' && Array.isArray(payload)) {
      const byId = new Map((payload as TrackPoint[]).map((p) => [p.id, p]))
      if (byId.size > 0) this.setTrack(this.trackPoints.map((p) => byId.get(p.id) ?? p))
    } else if (topic === 'trackingPoint' && typeof payload === 'object' && payload !== null) {
      const point = payload as TrackPoint
      if (!this.trackPoints.some((p) => p.id === point.id)) this.setTrack([...this.trackPoints, point])
    }
  }

  private emit(topic: LiveTopic, payload: unknown): void {
    for (const listener of this.topicListeners.get(topic) ?? []) listener(payload as never)
  }
}

/** Reads each kind of message from its raw fields, or null when they are not what that kind carries. */
const READERS: Record<string, (r: Record<string, unknown>) => LanServerMessage | null> = {
  paired: (r) => (typeof r.token === 'string' ? { t: 'paired', token: r.token } : null),
  denied: () => ({ t: 'denied' }),
  hb: () => ({ t: 'hb' }),
  error: (r) => ({ t: 'error', message: String(r.message ?? '') }),
  snapshot: (r) =>
    typeof r.topics === 'object' && r.topics !== null
      ? {
          t: 'snapshot',
          topics: r.topics as LiveSnapshot,
          flight: (r.flight ?? null) as LanFlightSnapshot | null
        }
      : null,
  flight: (r) => ({ t: 'flight', flight: (r.flight ?? null) as LanFlightSnapshot | null }),
  result: (r) =>
    typeof r.id === 'number'
      ? { t: 'result', id: r.id, data: r.data, ...(r.error === true ? { error: true as const } : {}) }
      : null,
  topic: (r) =>
    typeof r.name === 'string' ? { t: 'topic', name: r.name as LiveTopic, payload: r.payload } : null
}

/**
 * @param text A message from the PC.
 * @returns The message when it is one of the kinds the PC sends, otherwise null. Never throws.
 */
export function parseServerMessage(text: string): LanServerMessage | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const read = typeof record.t === 'string' && Object.hasOwn(READERS, record.t) ? READERS[record.t] : null
  return read ? read(record) : null
}
