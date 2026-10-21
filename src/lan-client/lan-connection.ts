/**
 * The second-screen page's link to the PC (winglog-backend's docs/plans/lan-web-viewer.md): pairs once with the code the PC shows, keeps
 * the token it hands back, and from then on says hello with it, receives the snapshot and each live topic, and reconnects when the link
 * drops. Holds no UI; the page reads `state`, `flight` and the topics from it.
 */

import type { LiveSnapshot, LiveTopic, LiveTopics } from '@shared/live'
import type { LanFlightSnapshot, LanServerMessage, TrackPoint } from '@shared/ipc'
import {
  AIRPORT_REFRESH_QUERIES,
  isKept,
  isWorthKeeping,
  laneOf,
  LAN_QUERY_KINDS,
  type LanQueryLane
} from '@shared/lan-queries'
import { queryFailedReport } from '@shared/lan-report'

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

/** Most lookups of each lane asked of the PC at once: it answers this many per device and says busy to the rest, so the rest wait their turn here. */
const MAX_IN_FLIGHT: Record<LanQueryLane, number> = { fast: 4, slow: 2 }

/** How long a lookup waits for its answer, in milliseconds: quick ones answer from the PC's own data, slow ones reach the sim or the internet. */
const QUERY_TIMEOUT_MS: Record<LanQueryLane, number> = { fast: 10_000, slow: 180_000 }

/** How many times a lookup is sent before it is given up on (the first, and three retries). */
const MAX_TRIES = 4

/** The wait before the first retry of a lookup that failed or timed out, in milliseconds. It doubles each time, with jitter. */
const RETRY_BASE_MS = 1000

/** A connected link that has heard nothing for this long is treated as dead: the PC sends a heartbeat every 10 s. */
const STALE_MS = 35_000
/** How often the link checks it has heard from the PC. */
const STALE_CHECK_MS = 5_000

/** Longest wait between reconnect attempts, in milliseconds. */
const MAX_BACKOFF_MS = 10_000

type StateListener = (state: LanLinkState) => void

/** A lookup asked of the PC, with everything waiting on its answer. */
interface Lookup {
  name: string
  args: unknown[]
  lane: LanQueryLane
  /** What identifies the ask for sharing and keeping, when the answer may be kept. */
  key: string | null
  waiters: { resolve: (data: unknown) => void; reject: (error: Error) => void }[]
  /** How many times it has been sent. */
  tries: number
  /** The id of the send that is out, and its timeout. */
  id?: number
  timer?: ReturnType<typeof setTimeout>
  retry?: ReturnType<typeof setTimeout>
}

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
  /** Lookups out with the PC, by the id they were sent with. */
  private readonly inFlight = new Map<number, Lookup>()
  /** Lookups waiting for one of the PC's few lookup slots, by lane, oldest first. */
  private readonly waiting: Record<LanQueryLane, Lookup[]> = { fast: [], slow: [] }
  /** Lookups waiting out the pause before a retry. */
  private readonly retrying = new Set<Lookup>()
  /** Lookups of a kept kind that are out or waiting, so the same ask made twice shares one request. */
  private readonly sharing = new Map<string, Lookup>()
  /** Answers kept for the length of this connection (see `isKept`). */
  private readonly kept = new Map<string, { data: unknown; subject: unknown }>()
  /** When the link dropped with lookups waiting, so they can be given up on if it does not come back. */
  private downSince: number | null = null
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
   * Sends the PC a command (the same validated ones the app's own window uses).
   *
   * @param name The command's name.
   * @param args Its arguments.
   * @throws When the link is not up.
   */
  command(name: string, ...args: unknown[]): void {
    if (!this.socket || this.current !== 'connected') throw new Error('Not connected')
    this.socket.send(JSON.stringify({ t: 'cmd', name, args }))
  }

  /**
   * Asks the PC for read-only data the page needs (the airfield list, a taxi chart, stands, procedures). Quick and slow lookups use
   * separate slots, a failed or unanswered one is asked again (waiting longer each time), the same lookup asked twice is one request,
   * and an answer about data that only changes when the PC refreshes it is kept for the length of the connection.
   *
   * @param name The lookup's name.
   * @param args Its arguments, such as an airport code.
   * @returns The answer; rejects when the link is down, or the PC could not answer after MAX_TRIES tries.
   */
  query(name: string, ...args: unknown[]): Promise<unknown> {
    const key = isKept(name) ? JSON.stringify([name, args]) : null
    const keptAnswer = key === null ? undefined : this.kept.get(key)
    if (keptAnswer) return Promise.resolve(keptAnswer.data)
    if (!this.socket || this.current !== 'connected') return Promise.reject(new Error('Not connected'))
    return new Promise((resolve, reject) => {
      const shared = key === null ? undefined : this.sharing.get(key)
      if (shared) {
        shared.waiters.push({ resolve, reject })
        return
      }
      const lookup: Lookup = { name, args, lane: laneOf(name), key, waiters: [{ resolve, reject }], tries: 0 }
      if (key !== null) this.sharing.set(key, lookup)
      this.waiting[lookup.lane].push(lookup)
      this.sendWaiting()
    })
  }

  /**
   * Tells the PC about something the page gave up on, so its log shows both sides of a problem. A code from a fixed list
   * (shared/lan-report.ts); nothing is sent while the link is down.
   *
   * @param code What happened.
   */
  report(code: string): void {
    if (this.socket && this.current === 'connected') this.socket.send(JSON.stringify({ t: 'report', code }))
  }

  /** Sends waiting lookups while the PC has a slot free for them in their lane. */
  private sendWaiting(): void {
    const socket = this.socket
    if (!socket || this.current !== 'connected') return
    for (const lane of ['fast', 'slow'] as const) {
      const sent = [...this.inFlight.values()].filter((l) => l.lane === lane).length
      let free = MAX_IN_FLIGHT[lane] - sent
      while (free > 0) {
        const next = this.waiting[lane].shift()
        if (!next) break
        free -= 1
        const id = this.nextQueryId++
        next.id = id
        next.tries += 1
        next.timer = setTimeout(() => this.failed(next, 'The PC did not answer'), QUERY_TIMEOUT_MS[lane])
        this.inFlight.set(id, next)
        socket.send(JSON.stringify({ t: 'query', id, name: next.name, args: next.args }))
      }
    }
  }

  /**
   * A send came to nothing (the PC could not answer, said busy, or did not answer in time): try again after a pause, or give up.
   *
   * @param lookup The lookup.
   * @param reason What to tell the callers if it is given up on.
   * @param waitMs How long the PC asked to wait (busy), when it said.
   */
  private failed(lookup: Lookup, reason: string, waitMs?: number): void {
    this.letGo(lookup)
    if (lookup.tries >= MAX_TRIES) {
      this.settle(lookup, new Error(reason))
      if (Object.hasOwn(LAN_QUERY_KINDS, lookup.name)) this.report(queryFailedReport(lookup.name))
      this.sendWaiting()
      return
    }
    const wait = waitMs ?? RETRY_BASE_MS * 2 ** (lookup.tries - 1) * (0.5 + Math.random() / 2)
    this.retrying.add(lookup)
    lookup.retry = setTimeout(() => {
      this.retrying.delete(lookup)
      this.waiting[lookup.lane].push(lookup)
      this.sendWaiting()
    }, wait)
    this.sendWaiting()
  }

  /**
   * @param lookup A lookup that was out: stops its timeout and frees its slot.
   */
  private letGo(lookup: Lookup): void {
    clearTimeout(lookup.timer)
    if (lookup.id !== undefined) this.inFlight.delete(lookup.id)
    lookup.id = undefined
  }

  /**
   * Ends a lookup for good, telling everyone waiting on it.
   *
   * @param lookup The lookup.
   * @param outcome The answer, or the error to give.
   */
  private settle(lookup: Lookup, outcome: Error | { data: unknown }): void {
    if (lookup.key !== null) this.sharing.delete(lookup.key)
    for (const waiter of lookup.waiters) {
      if (outcome instanceof Error) waiter.reject(outcome)
      else waiter.resolve(outcome.data)
    }
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
    this.failAllLookups(new Error('Not connected'))
  }

  /**
   * Pairs with the code the PC shows.
   *
   * @param code What the person typed.
   */
  pair(code: string): void {
    this.pairingCode = code.trim()
    this.setState('starting')
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
      this.holdLookups()
      if (this.stopped) return
      if (this.pairingCode !== null) {
        // The PC never answered the code (it was unreachable): back to asking for it, as there is no token to retry with.
        this.pairingCode = null
        this.setState('needs-pairing')
        return
      }
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
    this.failStaleLookups()
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
  private answerQuery(message: {
    id: number
    data?: unknown
    error?: true
    busy?: true
    retryAfterMs?: number
  }): void {
    const lookup = this.inFlight.get(message.id)
    if (!lookup) return
    if (message.error) {
      this.failed(lookup, 'The PC could not answer', message.busy ? message.retryAfterMs : undefined)
      return
    }
    this.letGo(lookup)
    if (lookup.key !== null && isWorthKeeping(message.data)) {
      this.kept.set(lookup.key, { data: message.data, subject: lookup.args[0] })
    }
    // A refresh from the sim makes what was kept about that airport out of date.
    if (AIRPORT_REFRESH_QUERIES.includes(lookup.name)) {
      for (const [key, entry] of this.kept) if (entry.subject === lookup.args[0]) this.kept.delete(key)
    }
    this.settle(lookup, { data: message.data })
    this.sendWaiting()
  }

  /**
   * The link dropped. Lookups that were out go back to waiting, without using up a try, and everything waits for the link to come
   * back; ones still waiting when it has been down for STALE_MS are failed (see `failStaleLookups`).
   */
  private holdLookups(): void {
    // Newest first, so the oldest ends up at the front again.
    for (const lookup of [...this.inFlight.values()].reverse()) {
      this.letGo(lookup)
      lookup.tries -= 1
      this.waiting[lookup.lane].unshift(lookup)
    }
    if (this.hasLookups()) this.downSince ??= Date.now()
  }

  private hasLookups(): boolean {
    return this.waiting.fast.length + this.waiting.slow.length + this.retrying.size > 0
  }

  /** Fails the lookups still waiting once the link has been down for STALE_MS: the page would rather say so than wait. */
  private failStaleLookups(): void {
    if (this.downSince === null || Date.now() - this.downSince < STALE_MS) return
    this.failAllLookups(new Error('Not connected'))
  }

  /**
   * @param error What to tell everyone waiting.
   */
  private failAllLookups(error: Error): void {
    this.downSince = null
    for (const lookup of [...this.inFlight.values()]) this.letGo(lookup)
    for (const lookup of this.retrying) clearTimeout(lookup.retry)
    const all = [...this.waiting.fast, ...this.waiting.slow, ...this.retrying]
    this.waiting.fast.length = 0
    this.waiting.slow.length = 0
    this.retrying.clear()
    for (const lookup of all) this.settle(lookup, error)
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
    // The PC may have refreshed its data, or restarted, while the link was down.
    this.kept.clear()
    this.downSince = null
    for (const key of Object.keys(this.topics)) delete this.topics[key as LiveTopic]
    Object.assign(this.topics, topics)
    this.setState('connected')
    this.sendWaiting()
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
  error: (r) => ({
    t: 'error',
    message: String(r.message ?? ''),
    ...(typeof r.retryAfterMs === 'number' ? { retryAfterMs: r.retryAfterMs } : {})
  }),
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
      ? {
          t: 'result',
          id: r.id,
          data: r.data,
          ...(r.error === true ? { error: true as const } : {}),
          ...(r.busy === true ? { busy: true as const } : {}),
          ...(typeof r.retryAfterMs === 'number' ? { retryAfterMs: r.retryAfterMs } : {})
        }
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
