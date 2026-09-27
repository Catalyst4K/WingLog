import { EventEmitter } from 'node:events'
import { WebSocket as NodeWebSocket } from 'node:http'
import type {
  BeyondAtcCallsign,
  BeyondAtcCom2,
  BeyondAtcCommsState,
  BeyondAtcConnectionStatus,
  BeyondAtcFacility,
  BeyondAtcProgress,
  BeyondAtcState,
  BeyondAtcTranscriptEntry
} from '@shared/ipc'

/** `BeyondATC.exe`'s own real local port, confirmed live 2026-09-25 (docs/beyondatc-notes.md)
 *  — `0.0.0.0:41716`, LAN-reachable, real `websocket-sharp` server. Fixed and not user-
 *  configurable on BeyondATC's own side (unlike GSX's genuinely variable Remote Client
 *  port), so this is the one production callers ever pass. The second port BeyondATC opens,
 *  `[::1]:57700`, is a different, unrelated, effectively unreachable server (a confirmed bug
 *  in BeyondATC's own IPv6 handling) — never connect to it. */
export const BEYONDATC_PORT = 41716

/** Matches the global/`node:http` WebSocket constructor — injected so tests don't need a
 *  real BeyondATC install (mirrors GsxRemoteService's own WebSocketCtor injection). */
export type WebSocketCtor = typeof NodeWebSocket

// Reconnect behaviour is undesigned on BeyondATC's own side (flightdeck-backend's
// beyondatc-integration.md, open question 3) — reused verbatim from GsxRemoteService rather
// than invented, since it's already a reasonable "fast retry, back off if it stays down"
// shape for exactly this kind of local add-on connection.
const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 600
const RECONNECT_BACKOFF_FACTOR = 1.6

const TRANSCRIPT_LIMIT = 100

export const EMPTY_STATE: BeyondAtcState = {
  facility: null,
  com2: null,
  callsign: null,
  commsState: null,
  progress: null,
  actions: []
}

interface BeyondAtcServiceEvents {
  status: [BeyondAtcConnectionStatus]
  state: [BeyondAtcState]
  transcript: [BeyondAtcTranscriptEntry[]]
}

const COMMS_MODES = new Set(['queued', 'ready', 'awaiting', 'speaking', 'request', 'traffic'])

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isCom2(value: unknown): value is BeyondAtcCom2 {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { label?: unknown }).label === 'string' &&
    typeof (value as { frequency?: unknown }).frequency === 'string' &&
    typeof (value as { monitor?: unknown }).monitor === 'boolean'
  )
}

function isCallsign(value: unknown): value is BeyondAtcCallsign {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { full?: unknown }).full === 'string' &&
    typeof (value as { shortForm?: unknown }).shortForm === 'string'
  )
}

function isCommsState(value: unknown): value is BeyondAtcCommsState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { text?: unknown }).text === 'string' &&
    COMMS_MODES.has((value as { mode?: unknown }).mode as string)
  )
}

function isProgress(value: unknown): value is BeyondAtcProgress {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { from?: unknown }).from === 'string' &&
    typeof (value as { to?: unknown }).to === 'string' &&
    typeof (value as { pct?: unknown }).pct === 'number'
  )
}

/** `Facility: <name>|<frequency>` — confirmed live, docs/beyondatc-notes.md. Malformed
 *  (missing separator) parses to null rather than a half-populated guess. */
function parseFacility(rest: string): BeyondAtcFacility | null {
  const sep = rest.indexOf('|')
  if (sep < 0) return null
  return { name: rest.slice(0, sep).trim(), frequency: rest.slice(sep + 1).trim() }
}

/** `Actions: [Label¬Label¬...¬]` — bracket-wrapped, `¬`-separated plain labels, confirmed
 *  live NOT to be JSON despite the `[...]` syntax (docs/beyondatc-notes.md). A trailing `¬`
 *  before the close bracket is normal (BeyondATC's own "Fire Action 1/2/3" numbering) and
 *  produces a trailing empty entry, filtered out here. `[]` (no menu offered) parses to []. */
function parseActions(rest: string): string[] {
  const trimmed = rest.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
  const inner = trimmed.slice(1, -1)
  if (inner === '') return []
  return inner.split('¬').filter((label) => label !== '')
}

/**
 * Owns the live WebSocket connection to `BeyondATC.exe`'s own local server
 * (flightdeck-backend's docs/plans/beyondatc-integration.md; real protocol findings in
 * docs/beyondatc-notes.md, confirmed live 2026-09-25). Parses BeyondATC's plain-text
 * `Key: value`/`Key: <JSON>` line protocol — a genuinely different wire shape from GSX
 * Remote Control's JSON-envelope snapshot/patch messages, even though the rest of this
 * class (constructor, start/stop, reconnect, event emitter) mirrors GsxRemoteService
 * directly. Only Parts 1-2 of the plan's state/commands are surfaced (transcript, live
 * facility/com2/callsign/commsState/progress, Actions, set_action/set_frequency*) —
 * everything else in the wire catalogue (DATIS, CPDLC code, auto-tune/respond, settings,
 * …) is simply never reflected in getState(), not an oversight.
 */
export class BeyondAtcService extends EventEmitter<BeyondAtcServiceEvents> {
  private ws: InstanceType<WebSocketCtor> | undefined
  private stopped = true
  private reconnectTimer: NodeJS.Timeout | undefined
  private backoffMs = RECONNECT_MIN_MS
  private status: BeyondAtcConnectionStatus = { state: 'disconnected', lastError: null }

  private state: BeyondAtcState = { ...EMPTY_STATE }
  private transcript: BeyondAtcTranscriptEntry[] = []

  constructor(
    private host: string,
    private readonly port: number = BEYONDATC_PORT,
    private readonly WebSocketImpl: WebSocketCtor = NodeWebSocket
  ) {
    super()
  }

  getStatus(): BeyondAtcConnectionStatus {
    return this.status
  }

  getState(): BeyondAtcState {
    return this.state
  }

  getTranscript(): BeyondAtcTranscriptEntry[] {
    return this.transcript
  }

  /** Fires the given entry from the live Actions list. No-op if not connected — same
   *  guard `sendCommand` below already enforces. */
  setAction(label: string): void {
    this.sendCommand(`set_action: ${label}`)
  }

  setFrequency(frequency: string): void {
    this.sendCommand(`set_frequency: ${frequency}`)
  }

  setFrequencyCom2(frequency: string): void {
    this.sendCommand(`set_frequency_com2: ${frequency}`)
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

  /** Restarts against a possibly-changed host — settings changed while connected. Port
   *  never changes (BEYONDATC_PORT is fixed), unlike GsxRemoteService's reconfigure. */
  reconfigure(host: string): void {
    this.host = host
    this.state = { ...EMPTY_STATE }
    this.transcript = []
    if (!this.stopped) {
      this.ws?.close()
      this.connect()
    }
  }

  private sendCommand(text: string): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(text)
  }

  private setStatus(status: BeyondAtcConnectionStatus): void {
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
    })

    socket.addEventListener('message', (event: { data: unknown }) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data)
      for (const line of raw.split('\n')) {
        this.handleLine(line.replace(/\r$/, ''))
      }
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

  private handleLine(line: string): void {
    if (line.trim() === '') return
    const sep = line.indexOf(':')
    if (sep < 0) return
    const key = line.slice(0, sep).trim()
    const rest = line.slice(sep + 1).trim()

    switch (key) {
      case 'Facility':
        this.state = { ...this.state, facility: parseFacility(rest) }
        this.emit('state', this.state)
        return
      case 'Com2': {
        const value = parseJson(rest)
        if (isCom2(value)) {
          this.state = { ...this.state, com2: value }
          this.emit('state', this.state)
        }
        return
      }
      case 'Callsign': {
        const value = parseJson(rest)
        if (isCallsign(value)) {
          this.state = { ...this.state, callsign: value }
          this.emit('state', this.state)
        }
        return
      }
      case 'CommsState': {
        const value = parseJson(rest)
        if (isCommsState(value)) {
          this.state = { ...this.state, commsState: value }
          this.emit('state', this.state)
        }
        return
      }
      case 'Progress': {
        const value = parseJson(rest)
        if (isProgress(value)) {
          this.state = { ...this.state, progress: value }
          this.emit('state', this.state)
        }
        return
      }
      case 'Actions':
        this.state = { ...this.state, actions: parseActions(rest) }
        this.emit('state', this.state)
        return
      case 'Player':
      case 'ATC':
      case 'Traffic':
      case 'ATCTraffic':
        this.pushTranscript(key === 'ATCTraffic' ? 'atcTraffic' : (key.toLowerCase() as 'player' | 'atc' | 'traffic'), rest)
        return
      default:
        // Every other real key (DATIS, CPDLCCode, AutoTune, AutoRespond, InfoBoxes,
        // RadioMute, LoadState, Settings, ToolbarVersion, QueuedAction, DATIS_END) is
        // outside this plan's scope — ignored, not an error.
        return
    }
  }

  private pushTranscript(speaker: BeyondAtcTranscriptEntry['speaker'], text: string): void {
    this.transcript = [...this.transcript, { speaker, text, ts: Date.now() }].slice(-TRANSCRIPT_LIMIT)
    this.emit('transcript', this.transcript)
  }

  private scheduleReconnect(lastError: string | null = null): void {
    if (this.stopped) return
    this.setStatus({ state: 'disconnected', lastError })
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs)
    this.backoffMs = Math.min(RECONNECT_MAX_MS, Math.round(this.backoffMs * RECONNECT_BACKOFF_FACTOR))
  }
}
