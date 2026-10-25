/**
 * The second-screen server (winglog-backend's docs/plans/lan-web-viewer.md, decisions.md 2026-10-02): one HTTP page and one WebSocket on a
 * single private-network address. The page carries no data; the socket carries live state only to a device that has paired, and takes
 * commands only through the remote-safe command tables. Nothing here reads the database or the filesystem itself: the live hub, the
 * commands, the device store and the static files all arrive as dependencies.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { laneOf, type LanQueryLane } from '@shared/lan-queries'
import { parseReport, parseReportDetail } from '@shared/lan-report'
import type { LiveCommand, LiveSnapshot, LiveTopic } from '@shared/live'
import { describeError } from '../logging/describe-error'
import { logger } from '../logging/logger'
import type { LiveHub } from '../live/LiveHub'
import { dispatchCommand } from '../live/commands'
import { cleanDeviceName, hashToken, newDeviceToken, PAIRING_WINDOW_MS, PairingWindow } from './pairing'

/** The topics a paired device is sent. A topic added to `LiveTopics` is not sent until it is added here on purpose. */
export const LAN_TOPICS: readonly LiveTopic[] = [
  'simTelemetry',
  'simConnectionStatus',
  'trackingPoint',
  'trackingPointsUpdated',
  'procedureSelection',
  'plannedRoute',
  'taxiRoute',
  'networkTraffic',
  'simTraffic',
  'trafficLayers',
  'onlineStatus',
  'networkControllers',
  'storageStatus',
  'gsxRemoteStatus',
  'gsxRemoteServices',
  'gsxRemoteGate',
  'gsxRemoteMenu',
  'gsxRemotePrompt',
  'gsxRemoteCommandBar',
  'beyondAtcStatus',
  'beyondAtcState',
  'beyondAtcTranscript',
  'beyondAtcStepClimb',
  'beyondAtcArrival'
]

/** How often a silent socket is pinged; one that has not answered by the next round is dropped. */
export const HEARTBEAT_MS = 10_000
/** Most arguments a lookup takes. */
const MAX_QUERY_ARGS = 6
/** Quick lookups (from the PC's own data) one device may have waiting at once. */
export const MAX_PENDING_FAST = 4
/** Slow lookups (that reach the sim or the internet) one device may have waiting at once, counted apart so they cannot hold up quick ones. */
export const MAX_PENDING_SLOW = 2
/** Largest message a device may send, in bytes. */
export const MAX_MESSAGE_BYTES = 16 * 1024
/** Most open sockets at once. */
export const MAX_SOCKETS = 8
/** Most sockets one address may have open without having paired or said hello, so one device on the network can't fill every slot. */
export const MAX_UNAUTHENTICATED_PER_ADDRESS = 4
/** How long a socket may stay unauthenticated, in milliseconds. */
export const AUTH_TIMEOUT_MS = 10_000
/** How many messages one socket may send in a burst (a token bucket's size). */
export const RATE_BURST = 40
/** How many messages a second one socket may keep sending (the bucket's refill). */
export const RATE_PER_SECOND = 20
/** A socket that keeps sending this many times the rate after it is told to wait is closed as abusive. */
export const ABUSE_FACTOR = 5
/** What a device is told to wait before asking again when it has too many lookups waiting, in milliseconds. */
const BUSY_RETRY_MS = 250
/** A lookup that takes longer than this is written to the log, in milliseconds. */
export const SLOW_QUERY_LOG_MS = 2000
/** The most often one device's report of the same thing is written to the log, in milliseconds. */
export const REPORT_LOG_INTERVAL_MS = 60_000
/** A socket with more than this waiting to be sent is too slow to keep. */
export const MAX_BUFFERED_BYTES = 1024 * 1024

/** One file the page needs. */
export interface StaticFile {
  type: string
  body: Buffer | string
}

/** What the server is given to work with. */
export interface LanServerDeps {
  hub: Pick<LiveHub, 'subscribe' | 'snapshot'>
  /** The commands a device may send (BeyondATC and GSX only). */
  commands: Partial<Record<LiveCommand, (...args: unknown[]) => void>>
  devices: {
    add(name: string, tokenHash: string): number
    find(tokenHash: string): number | null
    touch(id: number): void
  }
  /** The active flight's route and waypoints, read-only, for a device that connects (null when there is none). */
  flight(): unknown
  /** Read-only lookups a device may ask for (airfields, taxi charts, stands), each checking its own argument. */
  queries: Record<string, (...args: unknown[]) => unknown>
  /** A cheap text that changes when `flight()` would answer differently (the flight shown, or its saved details). */
  flightKey?(): string
  /** Called when the flight shown, or its saved details, changed (as `flightKey` told), so what is built from it can be built again. */
  onFlightChanged?(): void
  /** A page file for a path such as `/` or `/app.js`, or null. */
  staticFile(path: string): StaticFile | null
  now(): number
  /** How long a socket may stay unauthenticated; `AUTH_TIMEOUT_MS` when left out (tests shorten it). */
  authTimeoutMs?: number
  /** How often sockets are pinged; `HEARTBEAT_MS` when left out (tests shorten it). */
  heartbeatMs?: number
}

/** What a device may send. Anything else is dropped. */
type Incoming =
  | { t: 'pair'; code: unknown; name?: unknown }
  | { t: 'hello'; token: unknown }
  | { t: 'cmd'; name: unknown; args: unknown }
  | { t: 'query'; id: unknown; name: unknown; args: unknown }
  | { t: 'report'; code: unknown; detail?: unknown }

/** A connected socket and what is known of it. */
interface Client {
  socket: WebSocket
  /** The network address it connected from. */
  address: string | undefined
  deviceId: number | null
  /** The rate limit's token bucket: messages the socket may still send now, and when it was last topped up. */
  tokens: number
  refilledAt: number
  /** Messages refused in the current second, to tell a burst from abuse. */
  refused: number
  refusedSince: number
  /** Queries asked and not yet answered, by lane. */
  pending: Record<LanQueryLane, number>
  /** Messages refused as busy since the last heartbeat, for the log. */
  busyRefusals: number
  /** When each report from the device was last written to the log. */
  reportedAt: Map<string, number>
  /** False from a ping until its pong: a socket still false at the next ping is dead (a locked phone, a dropped Wi-Fi). */
  alive: boolean
  authTimer: NodeJS.Timeout
}

/** The second-screen HTTP and WebSocket server. */
export class LanServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private unsubscribe: (() => void) | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private hostHeader = ''
  private pairing: PairingWindow | null = null
  private readonly clients = new Set<Client>()
  /** The flight the connected devices were last told about. */
  private sentFlightId: number | null = null
  private lastFlightKey: string | null = null

  constructor(private readonly deps: LanServerDeps) {}

  /** @returns True while the server is listening. */
  get listening(): boolean {
    return this.server !== null
  }

  /** @returns How many sockets are open. */
  get connectionCount(): number {
    return this.clients.size
  }

  /**
   * Starts listening on one address. Never `0.0.0.0`: the caller passes an address from `adapters.ts`.
   *
   * @param address The private-network address to bind.
   * @param port The port.
   * @returns Resolves once listening; rejects with the listen error (such as the port being in use).
   */
  start(address: string, port: number): Promise<void> {
    if (this.server) return Promise.reject(new Error('Already listening'))
    const server = createServer((req, res) => this.handleHttp(req, res))
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(wss, req, socket, head))
    this.hostHeader = `${address}:${port}`
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, address, () => {
        server.off('error', reject)
        server.on('error', (error) => logger.warn('[lan] server error:', error))
        this.server = server
        this.wss = wss
        this.unsubscribe = this.deps.hub.subscribe((topic, payload) => this.broadcast(topic, payload))
        this.heartbeat = setInterval(() => this.pingClients(), this.deps.heartbeatMs ?? HEARTBEAT_MS)
        this.heartbeat.unref()
        resolve()
      })
    })
  }

  /** Stops listening and closes every socket. */
  stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.pairing = null
    for (const client of [...this.clients]) client.socket.terminate()
    const server = this.server
    this.server = null
    this.wss?.close()
    this.wss = null
    return new Promise((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  /** @returns True while a pairing window is open: not yet used, expired or spent by wrong codes. */
  get pairingOpen(): boolean {
    return this.pairing?.isOpen(this.deps.now()) ?? false
  }

  /**
   * Opens a pairing window, replacing any open one.
   *
   * @returns The code to show and when the window closes (milliseconds since the epoch).
   */
  openPairing(): { code: string; expiresAt: number } {
    const now = this.deps.now()
    this.pairing = new PairingWindow(now)
    return { code: this.pairing.shownCode, expiresAt: now + PAIRING_WINDOW_MS }
  }

  /** Closes the pairing window. */
  closePairing(): void {
    this.pairing = null
  }

  /**
   * Drops every open socket belonging to a device, after it is revoked.
   *
   * @param deviceId The device.
   */
  disconnectDevice(deviceId: number): void {
    for (const client of this.clients) {
      if (client.deviceId === deviceId) {
        this.send(client, { t: 'denied' })
        client.socket.close()
      }
    }
  }

  /** Pings every socket and drops the ones that never answered the last ping, so a device that went away does not hold a slot. */
  private pingClients(): void {
    this.syncFlight()
    for (const client of this.clients) {
      this.logBusyRefusals(client)
      if (!client.alive) {
        client.socket.terminate()
        continue
      }
      client.alive = false
      client.socket.ping()
      if (client.deviceId !== null) this.send(client, { t: 'hb' })
    }
  }

  /**
   * Writes how many of a device's messages were refused as busy since the last round, once a round, so a flood is one line.
   *
   * @param client The device.
   */
  private logBusyRefusals(client: Client): void {
    if (client.busyRefusals === 0) return
    logger.warn(
      `[lan] device ${client.deviceId ?? 'not paired'}: ${client.busyRefusals} messages refused as busy in the last ${(this.deps.heartbeatMs ?? HEARTBEAT_MS) / 1000} s`
    )
    client.busyRefusals = 0
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.headers.host !== this.hostHeader || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end()
      return
    }
    const path = (req.url ?? '/').split('?')[0]
    const file = this.deps.staticFile(path === '' ? '/' : path)
    if (!file) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'content-type': file.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // The tile requests must not tell OpenFreeMap which address on the home network this page came from.
      'referrer-policy': 'no-referrer',
      'content-security-policy': pageSecurityPolicy(this.hostHeader)
    })
    res.end(req.method === 'HEAD' ? undefined : file.body)
  }

  private handleUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: string): void => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
    if (req.url?.split('?')[0] !== '/live') return refuse('404 Not Found')
    // Host and Origin must name this server: a web page in another tab, or a rebound DNS name, can't open a socket to it.
    if (req.headers.host !== this.hostHeader) return refuse('403 Forbidden')
    const origin = req.headers.origin
    if (origin !== undefined && !originMatches(origin, this.hostHeader)) return refuse('403 Forbidden')
    if (this.clients.size >= MAX_SOCKETS) return refuse('503 Service Unavailable')
    const address = req.socket.remoteAddress
    let waiting = 0
    for (const client of this.clients)
      if (client.deviceId === null && client.address === address) waiting += 1
    if (waiting >= MAX_UNAUTHENTICATED_PER_ADDRESS) return refuse('429 Too Many Requests')
    wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, address))
  }

  private accept(socket: WebSocket, address: string | undefined): void {
    const client: Client = {
      socket,
      address,
      deviceId: null,
      tokens: RATE_BURST,
      refilledAt: this.deps.now(),
      refused: 0,
      refusedSince: this.deps.now(),
      pending: { fast: 0, slow: 0 },
      busyRefusals: 0,
      reportedAt: new Map(),
      alive: true,
      authTimer: setTimeout(() => socket.close(), this.deps.authTimeoutMs ?? AUTH_TIMEOUT_MS)
    }
    this.clients.add(client)
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      this.handleMessage(client, data.toString())
    })
    socket.on('pong', () => (client.alive = true))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(client.authTimer)
      this.clients.delete(client)
    })
  }

  private handleMessage(client: Client, text: string): void {
    const now = this.deps.now()
    const message = parseIncoming(text)
    if (!message) return
    if (!this.takeToken(client, now)) return this.refuse(client, message, now)
    if (message.t === 'pair') return this.handlePair(client, message, now)
    if (message.t === 'hello') return this.handleHello(client, message.token)
    if (client.deviceId === null) return
    if (message.t === 'query') return this.handleQuery(client, message)
    if (message.t === 'report') return this.handleReport(client, message.code, message.detail, now)
    try {
      dispatchCommand(this.deps.commands, message.name, message.args)
    } catch (error) {
      // Answered the same whatever went wrong, so a device learns nothing from it; but the PC's log says which command failed and why, or a
      // real bug in a command would leave no trace at all.
      this.logOncePerMinute(
        client,
        `command-failed:${logName(message.name)}`,
        now,
        `[lan] device ${client.deviceId} command ${logName(message.name)} failed: ${describeError(error)}`
      )
      this.send(client, { t: 'error', message: 'Not allowed' })
    }
  }

  /**
   * Spends one message from the socket's bucket: it holds RATE_BURST and fills at RATE_PER_SECOND.
   *
   * @param client The socket.
   * @param now The time, in milliseconds.
   * @returns False when the bucket is empty and the message is over the limit.
   */
  private takeToken(client: Client, now: number): boolean {
    const elapsed = Math.max(0, now - client.refilledAt)
    client.tokens = Math.min(RATE_BURST, client.tokens + (elapsed * RATE_PER_SECOND) / 1000)
    client.refilledAt = now
    if (client.tokens < 1) return false
    client.tokens -= 1
    return true
  }

  /**
   * Answers a message that is over the limit, so its sender is told to wait and ask again rather than left to time out. A socket that
   * keeps sending long after it is told is closed.
   *
   * @param client The socket.
   * @param message The message that was refused.
   * @param now The time, in milliseconds.
   */
  private refuse(client: Client, message: Incoming, now: number): void {
    if (now - client.refusedSince >= 1000) {
      client.refusedSince = now
      client.refused = 0
    }
    client.refused += 1
    client.busyRefusals += 1
    if (client.refused > ABUSE_FACTOR * RATE_PER_SECOND) {
      logger.warn(
        `[lan] device ${client.deviceId ?? 'not paired'}: closed for sending far more than it was told to wait for`
      )
      client.socket.close()
      return
    }
    const retryAfterMs = Math.max(50, Math.ceil(((1 - client.tokens) * 1000) / RATE_PER_SECOND))
    if (message.t === 'query' && typeof message.id === 'number' && Number.isSafeInteger(message.id)) {
      this.send(client, { t: 'result', id: message.id, error: true, busy: true, retryAfterMs })
    } else if (message.t === 'cmd') {
      this.send(client, { t: 'error', message: 'busy', retryAfterMs })
    }
    // Pairing and hello from a socket not yet let in are dropped: there is nobody to tell.
  }

  /**
   * Answers a device's lookup. Only names in the queries table run, each checks its own argument, and a device may have a few in flight at once.
   *
   * @param client The device.
   * @param message Its query: a number to match the answer to, the lookup's name and its argument list.
   */
  private handleQuery(client: Client, message: { id: unknown; name: unknown; args: unknown }): void {
    const { id, name } = message
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return
    const query =
      typeof name === 'string' && Object.hasOwn(this.deps.queries, name) ? this.deps.queries[name] : null
    const args = message.args === undefined ? [] : message.args
    if (!query || !Array.isArray(args) || args.length > MAX_QUERY_ARGS) {
      logger.warn(
        `[lan] device ${client.deviceId}: lookup refused (${query ? 'bad arguments' : 'unknown lookup'} ${logName(name)})`
      )
      this.send(client, { t: 'result', id, error: true })
      return
    }
    const lane = laneOf(name as string)
    if (client.pending[lane] >= (lane === 'slow' ? MAX_PENDING_SLOW : MAX_PENDING_FAST)) {
      client.busyRefusals += 1
      this.send(client, { t: 'result', id, error: true, busy: true, retryAfterMs: BUSY_RETRY_MS })
      return
    }
    client.pending[lane] += 1
    const startedAt = this.deps.now()
    new Promise((resolve) => resolve(query(...(args as unknown[]))))
      .then(
        (data) => {
          const tookMs = this.deps.now() - startedAt
          if (tookMs > SLOW_QUERY_LOG_MS) logger.info(`[lan] lookup ${logName(name)} took ${tookMs} ms`)
          this.send(client, { t: 'result', id, data })
        },
        (error: unknown) => {
          logger.warn(`[lan] lookup ${logName(name)} failed: ${describeError(error)}`)
          this.send(client, { t: 'result', id, error: true })
        }
      )
      .finally(() => (client.pending[lane] -= 1))
  }

  /**
   * Writes what a device says to the log, so both sides of a problem are there: what it gave up on, and that it heard what the PC pushed.
   * Only a code from the fixed list is written, with a detail only where the code takes one and it is acceptable, and the same code from the
   * same device at most once a minute.
   *
   * @param client The device.
   * @param code What it sent.
   * @param detail What it sent with it.
   * @param now The time, in milliseconds.
   */
  private handleReport(client: Client, code: unknown, detail: unknown, now: number): void {
    const known = parseReport(code)
    if (!known) {
      this.logOncePerMinute(
        client,
        'unknown',
        now,
        `[lan] device ${client.deviceId} sent a report the PC does not know`
      )
      return
    }
    const text = parseReportDetail(known, detail)
    this.logOncePerMinute(
      client,
      known,
      now,
      `[lan] device ${client.deviceId} reports ${known}${text ? `: ${text}` : ''}`
    )
  }

  /**
   * Writes a line to the log, unless the same thing was written for this device in the last minute, so a misbehaving page cannot fill it.
   *
   * @param client The device.
   * @param key What the line is about.
   * @param now The time, in milliseconds.
   * @param line The line.
   */
  private logOncePerMinute(client: Client, key: string, now: number, line: string): void {
    const last = client.reportedAt.get(key)
    if (last !== undefined && now - last < REPORT_LOG_INTERVAL_MS) return
    client.reportedAt.set(key, now)
    logger.warn(line)
  }

  private handlePair(client: Client, message: { code: unknown; name?: unknown }, now: number): void {
    if (client.deviceId !== null) return
    const result = this.pairing?.attempt(message.code, now) ?? 'closed'
    if (result === 'paired') {
      const token = newDeviceToken()
      const deviceId = this.deps.devices.add(cleanDeviceName(message.name), hashToken(token))
      this.pairing = null
      this.send(client, { t: 'paired', token })
      this.authenticate(client, deviceId)
    } else {
      if (result === 'wrong') logger.warn('[lan] wrong pairing code from a device')
      this.send(client, { t: 'denied' })
      client.socket.close()
    }
  }

  private handleHello(client: Client, token: unknown): void {
    const deviceId = typeof token === 'string' ? this.deps.devices.find(hashToken(token)) : null
    if (deviceId === null) {
      this.send(client, { t: 'denied' })
      client.socket.close()
      return
    }
    this.deps.devices.touch(deviceId)
    this.authenticate(client, deviceId)
  }

  private authenticate(client: Client, deviceId: number): void {
    clearTimeout(client.authTimer)
    client.deviceId = deviceId
    const topics: LiveSnapshot = {}
    const snapshot = this.deps.hub.snapshot()
    const flight = this.deps.flight() as { flight?: { flightId?: number } } | null
    this.sentFlightId = flight?.flight?.flightId ?? null
    this.lastFlightKey = this.deps.flightKey?.() ?? null
    for (const topic of LAN_TOPICS) {
      if (topic in snapshot) (topics as Record<string, unknown>)[topic] = snapshot[topic]
    }
    this.send(client, { t: 'snapshot', topics, flight })
  }

  private broadcast(topic: LiveTopic, payload: unknown): void {
    if (!LAN_TOPICS.includes(topic)) return
    this.announceFlightChange(topic, payload)
    for (const client of this.clients) {
      if (client.deviceId !== null) this.send(client, { t: 'topic', name: topic, payload })
    }
  }

  /** Sends every paired device the flight again when the one shown, or its details, changed since they were last told. */
  private syncFlight(): void {
    const key = this.deps.flightKey?.()
    if (key === undefined || key === this.lastFlightKey) return
    this.lastFlightKey = key
    this.deps.onFlightChanged?.()
    const flight = this.deps.flight() as { flight?: { flightId?: number } } | null
    this.sentFlightId = flight?.flight?.flightId ?? null
    for (const client of this.clients) {
      if (client.deviceId !== null) this.send(client, { t: 'flight', flight })
    }
  }

  /**
   * A tracked point from a flight the devices have not been told about means tracking started (or moved on): sends them the flight first.
   *
   * @param topic The topic being published.
   * @param payload Its value.
   */
  private announceFlightChange(topic: LiveTopic, payload: unknown): void {
    if (topic !== 'trackingPoint' || typeof payload !== 'object' || payload === null) return
    const flightId = (payload as { flightId?: unknown }).flightId
    if (typeof flightId !== 'number' || flightId === this.sentFlightId) return
    this.sentFlightId = flightId
    const flight = this.deps.flight()
    for (const client of this.clients) {
      if (client.deviceId !== null) this.send(client, { t: 'flight', flight })
    }
  }

  private send(client: Client, message: unknown): void {
    const { socket } = client
    if (socket.readyState !== socket.OPEN) return
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.terminate()
      return
    }
    socket.send(JSON.stringify(message))
  }
}

/**
 * @param name A lookup's name as a device sent it.
 * @returns A short, safe version of it for the log: a device is not trusted to write what it likes there.
 */
function logName(name: unknown): string {
  return typeof name === 'string' ? `"${name.slice(0, 40).replace(/[^\w.:-]/g, '?')}"` : '(not a name)'
}

/**
 * What the page may load: its own files, the map tiles and style from OpenFreeMap, and its WebSocket back to this server, nothing else.
 *
 * @param host The host (with port) this server is bound to.
 * @returns The Content-Security-Policy header value.
 */
export function pageSecurityPolicy(host: string): string {
  return [
    "default-src 'self'",
    "img-src 'self' data: blob: https://tiles.openfreemap.org",
    `connect-src 'self' ws://${host} https://tiles.openfreemap.org`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

/**
 * @param origin The Origin header.
 * @param host The host (with port) this server is bound to.
 * @returns True when the origin is a web page served by this server.
 */
function originMatches(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * @param text A message as a device sent it.
 * @returns The message when it is one of the three kinds a device may send, otherwise null. Never throws.
 */
function parseIncoming(text: string): Incoming | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.t === 'pair') return { t: 'pair', code: record.code, name: record.name }
  if (record.t === 'hello') return { t: 'hello', token: record.token }
  if (record.t === 'cmd') return { t: 'cmd', name: record.name, args: record.args }
  if (record.t === 'query') return { t: 'query', id: record.id, name: record.name, args: record.args }
  if (record.t === 'report') return { t: 'report', code: record.code, detail: record.detail }
  return null
}
