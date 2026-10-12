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
    if (this.store.get()) this.connect()
    else this.setState('needs-pairing')
  }

  /** Closes the link and stops reconnecting. */
  stop(): void {
    this.stopped = true
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
    this.socket?.close()
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

  private handle(text: string): void {
    const message = parseServerMessage(text)
    if (!message) return
    switch (message.t) {
      case 'paired':
        this.store.set(message.token)
        this.pairingCode = null
        break
      case 'denied':
        if (this.pairingCode !== null) {
          this.pairingCode = null
          this.setState('wrong-code')
        } else {
          this.store.clear()
          this.setState('needs-pairing')
        }
        break
      case 'snapshot':
        this.backoff = 1000
        for (const key of Object.keys(this.topics)) delete this.topics[key as LiveTopic]
        Object.assign(this.topics, message.topics)
        this.flightSnapshot = message.flight
        this.setTrack(message.flight?.trackPoints ?? [])
        this.setState('connected')
        for (const listener of this.flightListeners) listener(message.flight)
        for (const [topic, value] of Object.entries(message.topics)) this.emit(topic as LiveTopic, value)
        break
      case 'flight':
        this.flightSnapshot = message.flight
        this.setTrack(message.flight?.trackPoints ?? [])
        for (const listener of this.flightListeners) listener(message.flight)
        break
      case 'topic':
        ;(this.topics as Record<string, unknown>)[message.name] = message.payload
        this.followTrack(message.name, message.payload)
        this.emit(message.name, message.payload)
        break
      case 'error':
        break
    }
  }

  private setTrack(points: TrackPoint[]): void {
    this.trackPoints = points
    for (const listener of this.trackListeners) listener()
  }

  /**
   * Keeps the track current from the two topics that carry it: a new point is added, a cleanup pass replaces them all.
   *
   * @param topic The topic that arrived.
   * @param payload Its value.
   */
  private followTrack(topic: LiveTopic, payload: unknown): void {
    if (topic === 'trackingPointsUpdated' && Array.isArray(payload)) {
      this.setTrack(payload as TrackPoint[])
    } else if (topic === 'trackingPoint' && typeof payload === 'object' && payload !== null) {
      const point = payload as TrackPoint
      if (!this.trackPoints.some((p) => p.id === point.id)) this.setTrack([...this.trackPoints, point])
    }
  }

  private emit(topic: LiveTopic, payload: unknown): void {
    for (const listener of this.topicListeners.get(topic) ?? []) listener(payload as never)
  }
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
  switch (record.t) {
    case 'paired':
      return typeof record.token === 'string' ? { t: 'paired', token: record.token } : null
    case 'denied':
      return { t: 'denied' }
    case 'error':
      return { t: 'error', message: String(record.message ?? '') }
    case 'snapshot':
      return typeof record.topics === 'object' && record.topics !== null
        ? {
            t: 'snapshot',
            topics: record.topics as LiveSnapshot,
            flight: (record.flight ?? null) as LanFlightSnapshot | null
          }
        : null
    case 'flight':
      return { t: 'flight', flight: (record.flight ?? null) as LanFlightSnapshot | null }
    case 'topic':
      return typeof record.name === 'string'
        ? { t: 'topic', name: record.name as LiveTopic, payload: record.payload }
        : null
    default:
      return null
  }
}
