/**
 * The second-screen server (winglog-backend's docs/plans/lan-web-viewer.md, decisions.md 2026-10-02): one HTTP page and one WebSocket on a
 * single private-network address. The page carries no data; the socket carries live state only to a device that has paired, and takes
 * commands only through the remote-safe command tables. Nothing here reads the database or the filesystem itself: the live hub, the
 * commands, the device store and the static files all arrive as dependencies.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { LiveCommand, LiveSnapshot, LiveTopic } from '@shared/live'
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

/** Largest message a device may send, in bytes. */
export const MAX_MESSAGE_BYTES = 16 * 1024
/** Most open sockets at once. */
export const MAX_SOCKETS = 8
/** How long a socket may stay unauthenticated, in milliseconds. */
export const AUTH_TIMEOUT_MS = 10_000
/** Most messages one socket may send in a second. */
export const MAX_MESSAGES_PER_SECOND = 20
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
  /** A page file for a path such as `/` or `/app.js`, or null. */
  staticFile(path: string): StaticFile | null
  now(): number
  /** How long a socket may stay unauthenticated; `AUTH_TIMEOUT_MS` when left out (tests shorten it). */
  authTimeoutMs?: number
}

/** What a device may send. Anything else is dropped. */
type Incoming =
  | { t: 'pair'; code: unknown; name?: unknown }
  | { t: 'hello'; token: unknown }
  | { t: 'cmd'; name: unknown; args: unknown }

/** A connected socket and what is known of it. */
interface Client {
  socket: WebSocket
  deviceId: number | null
  windowStart: number
  count: number
  authTimer: NodeJS.Timeout
}

/** The second-screen HTTP and WebSocket server. */
export class LanServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private unsubscribe: (() => void) | null = null
  private hostHeader = ''
  private pairing: PairingWindow | null = null
  private readonly clients = new Set<Client>()
  /** The flight the connected devices were last told about. */
  private sentFlightId: number | null = null

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
        resolve()
      })
    })
  }

  /** Stops listening and closes every socket. */
  stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
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
    wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
  }

  private accept(socket: WebSocket): void {
    const client: Client = {
      socket,
      deviceId: null,
      windowStart: this.deps.now(),
      count: 0,
      authTimer: setTimeout(() => socket.close(), this.deps.authTimeoutMs ?? AUTH_TIMEOUT_MS)
    }
    this.clients.add(client)
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      this.handleMessage(client, data.toString())
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(client.authTimer)
      this.clients.delete(client)
    })
  }

  private handleMessage(client: Client, text: string): void {
    const now = this.deps.now()
    if (now - client.windowStart >= 1000) {
      client.windowStart = now
      client.count = 0
    }
    client.count += 1
    if (client.count > MAX_MESSAGES_PER_SECOND) return
    const message = parseIncoming(text)
    if (!message) return
    if (message.t === 'pair') return this.handlePair(client, message, now)
    if (message.t === 'hello') return this.handleHello(client, message.token)
    if (client.deviceId === null) return
    try {
      dispatchCommand(this.deps.commands, message.name, message.args)
    } catch {
      this.send(client, { t: 'error', message: 'Not allowed' })
    }
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

  /** A tracked point from a flight the devices have not been told about means tracking started (or moved on): send them the flight first. */
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
  return null
}
