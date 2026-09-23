import { EventEmitter } from 'node:events'
import { WebSocket as NodeWebSocket } from 'node:http'
import type {
  GsxRemoteConnectionStatus,
  GsxRemoteGateInfo,
  GsxRemoteMenuState,
  GsxRemotePromptState,
  GsxRemoteServiceStatus
} from '@shared/ipc'

/** Matches the global/`node:http` WebSocket constructor — injected so tests don't need a
 *  real GSX install (mirrors SimConnectService's OpenSimConnect injection). */
export type WebSocketCtor = typeof NodeWebSocket

const EMPTY_MENU: GsxRemoteMenuState = {
  menuShown: false,
  title: '',
  header: '',
  subtitle: '',
  entries: [],
  icons: [],
  disabled: [],
  layout: ''
}

// GSX's own client uses this exact backoff (connection.js, docs/gsx-notes.md) — matched
// here rather than invented, since it's already tuned for GSX's own reconnect behaviour
// (fast after an engine restart, backing off if it stays down).
const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 600
const RECONNECT_BACKOFF_FACTOR = 1.6

interface GsxRemoteServiceEvents {
  status: [GsxRemoteConnectionStatus]
  services: [GsxRemoteServiceStatus[]]
  gate: [GsxRemoteGateInfo | null]
  menu: [GsxRemoteMenuState]
  prompt: [GsxRemotePromptState | null]
}

/** GSX's own wire message — see docs/gsx-notes.md for the real shape, confirmed live
 *  2026-09-21. A snapshot flattens the whole state onto the message itself; a patch
 *  replaces one top-level key (null drops it) — never deep-merged, matching GSX's own
 *  store.js exactly. */
interface SnapshotMessage {
  type: 'snapshot'
  [key: string]: unknown
}
interface PatchMessage {
  type: 'patch'
  path: string
  value: unknown
}
type GsxMessage = SnapshotMessage | PatchMessage | { type: string }

function isServiceArray(value: unknown): value is GsxRemoteServiceStatus[] {
  return Array.isArray(value)
}

/** The raw wire `/menu` object — everything but `menuShown`, which is GSX's own *separate*
 *  top-level key (`/menuShown`), not part of the menu object itself. */
function isRawMenu(value: unknown): value is Omit<GsxRemoteMenuState, 'menuShown'> {
  return typeof value === 'object' && value !== null && 'entries' in value
}

function isPromptState(value: unknown): value is GsxRemotePromptState {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'text'
}

/** The raw wire `/airport` object — confirmed live 2026-09-21 (docs/gsx-notes.md, round 6):
 *  `{icao, name, country}`. Only `icao`/`name` are used; `country` isn't shown anywhere. */
function isRawAirport(value: unknown): value is { icao: string; name: string } {
  return typeof value === 'object' && value !== null && typeof (value as { icao?: unknown }).icao === 'string'
}

/**
 * Owns the live WebSocket connection to GSX Pro's own "Remote Client" server
 * (flightdeck-backend's docs/plans/gsx-remote-control.md; real protocol findings in
 * docs/gsx-notes.md — spiked live 2026-09-21, not guessed). Tracks GSX's own state as a
 * flat object, same as GSX's own store.js, and exposes only the three slices WingLog's UI
 * needs: services (read-only status), menu (the real control surface, generic and
 * index-based), and prompt (a separate free-text modal). No embed, no exception to the
 * renderer-never-touches-network rule — this is the whole point of Option C
 * (docs/decisions.md, 2026-09-21).
 */
export class GsxRemoteService extends EventEmitter<GsxRemoteServiceEvents> {
  private ws: InstanceType<WebSocketCtor> | undefined
  private stopped = true
  private reconnectTimer: NodeJS.Timeout | undefined
  private backoffMs = RECONNECT_MIN_MS
  private status: GsxRemoteConnectionStatus = { state: 'disconnected', lastError: null }

  private state: Record<string, unknown> = {}

  constructor(
    private host: string,
    private port: number,
    private readonly WebSocketImpl: WebSocketCtor = NodeWebSocket
  ) {
    super()
  }

  getStatus(): GsxRemoteConnectionStatus {
    return this.status
  }

  getServices(): GsxRemoteServiceStatus[] {
    const value = this.state.services
    return isServiceArray(value) ? value : []
  }

  getMenu(): GsxRemoteMenuState {
    const raw = this.state.menu
    const base = isRawMenu(raw) ? raw : EMPTY_MENU
    // `menuShown` is a genuinely separate top-level key from `menu` itself (docs/gsx-
    // notes.md, 2026-09-21) — GSX's own client gates on both together, so this combines
    // them into one value for callers rather than making them track two.
    return { ...base, menuShown: this.state.menuShown === true }
  }

  getPrompt(): GsxRemotePromptState | null {
    const value = this.state.prompt
    return isPromptState(value) ? value : null
  }

  /** `state.airport`/`state.parking`/`state.gateProperties` — three separate top-level wire
   *  keys combined into one value for callers, same reasoning as getMenu's menuShown combine
   *  above. Confirmed live 2026-09-21, real VHHH session (docs/gsx-notes.md, round 6). Null
   *  until GSX has resolved a gate (`airport`/`parking` genuinely absent until then, not just
   *  empty — confirmed from the same capture's boot-time snapshot). */
  getGateInfo(): GsxRemoteGateInfo | null {
    const airport = this.state.airport
    const parking = this.state.parking
    if (!isRawAirport(airport) || typeof parking !== 'string') return null
    const gateProperties = this.state.gateProperties
    return {
      airportIcao: airport.icao,
      airportName: airport.name,
      parking,
      gateProperties: Array.isArray(gateProperties) ? gateProperties.filter((p) => typeof p === 'string') : []
    }
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = undefined
  }

  /** Restarts against a possibly-changed host/port — settings changed while connected. */
  reconfigure(host: string, port: number): void {
    this.host = host
    this.port = port
    this.state = {}
    if (!this.stopped) {
      this.ws?.close()
      this.connect()
    }
  }

  /** Picks the menu entry at this index — the only interaction GSX's own menu model
   *  exposes (docs/gsx-notes.md). No-op if not connected. */
  pickMenu(index: number): void {
    this.sendCommand('menu.pick', { index })
  }

  /** Opens the menu tree if closed, closes it if open — the exact same single toggle
   *  GSX's own client's permanent header sends (`menu.js`'s own `cmd(closed ?
   *  "menu.toggle" : "menu.close")`). This is the real, only way a genuine GSX remote
   *  opens the menu without the in-sim panel ever opening — confirmed by reading GSX's
   *  own shipped client source, 2026-09-21 (docs/gsx-notes.md). Passively mirroring
   *  `state.menu` was never enough; something has to actually send this. */
  toggleMenu(): void {
    if (this.getMenu().menuShown) this.sendCommand('menu.close')
    else this.sendCommand('menu.toggle')
  }

  submitPrompt(gen: number, text: string): void {
    this.sendCommand('input.submit', { gen, text })
  }

  cancelPrompt(gen: number): void {
    this.sendCommand('input.cancel', { gen })
  }

  private sendCommand(verb: string, args?: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(JSON.stringify(args ? { type: 'command', verb, args } : { type: 'command', verb }))
  }

  private setStatus(status: GsxRemoteConnectionStatus): void {
    this.status = status
    this.emit('status', status)
  }

  private connect(): void {
    if (this.stopped) return
    this.setStatus({ state: 'connecting', lastError: null })

    let socket: InstanceType<WebSocketCtor>
    try {
      socket = new this.WebSocketImpl(`ws://${this.host}:${this.port}/`)
    } catch (err) {
      this.scheduleReconnect((err as Error).message)
      return
    }
    this.ws = socket

    socket.addEventListener('open', () => {
      this.backoffMs = RECONNECT_MIN_MS
      this.setStatus({ state: 'connected', lastError: null })
      socket.send(JSON.stringify({ type: 'subscribe', channels: ['state', 'prompts', 'toasts'] }))
    })

    socket.addEventListener('message', (event: { data: unknown }) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data)
      let message: GsxMessage
      try {
        message = JSON.parse(raw)
      } catch {
        return
      }
      this.handleMessage(message)
    })

    socket.addEventListener('close', () => {
      if (this.ws !== socket) return // a stale socket's late close, already superseded
      this.ws = undefined
      this.scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      try {
        socket.close()
      } catch {
        // onclose drives the actual reconnect
      }
    })
  }

  private handleMessage(message: GsxMessage): void {
    if (message.type === 'snapshot') {
      const snapshot: Record<string, unknown> = { ...(message as SnapshotMessage) }
      delete snapshot.type
      this.state = snapshot
      this.emit('services', this.getServices())
      this.emit('gate', this.getGateInfo())
      this.emit('menu', this.getMenu())
      this.emit('prompt', this.getPrompt())
      return
    }
    if (message.type === 'patch') {
      const { path, value } = message as PatchMessage
      const key = path.replace(/^\//, '')
      if (value === null) delete this.state[key]
      else this.state[key] = value

      if (key === 'services') this.emit('services', this.getServices())
      else if (key === 'airport' || key === 'parking' || key === 'gateProperties') {
        this.emit('gate', this.getGateInfo())
      } else if (key === 'menu' || key === 'menuShown') this.emit('menu', this.getMenu())
      else if (key === 'prompt') this.emit('prompt', this.getPrompt())
    }
  }

  private scheduleReconnect(lastError: string | null = null): void {
    if (this.stopped) return
    this.setStatus({ state: 'disconnected', lastError })
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs)
    this.backoffMs = Math.min(RECONNECT_MAX_MS, Math.round(this.backoffMs * RECONNECT_BACKOFF_FACTOR))
  }
}
