/**
 * The live connection to BeyondATC's own WebSocket server: parses its `Key: value` line protocol into
 * WingLog's BeyondATC state and transcript, and sends its commands (actions, frequencies,
 * auto-tune). Reconnects whenever BeyondATC goes away.
 */
import { EventEmitter } from 'node:events'
import { NodeServiceSocket, type ServiceSocket, type ServiceSocketCtor } from '../net/service-socket'
import type {
  BeyondAtcCallsign,
  BeyondAtcCom2,
  BeyondAtcInfoBox,
  BeyondAtcCommsState,
  BeyondAtcConnectionStatus,
  BeyondAtcFacility,
  BeyondAtcFrequencyOption,
  BeyondAtcProgress,
  BeyondAtcState,
  BeyondAtcTranscriptEntry
} from '@shared/ipc'
import { assignedGate, parseAtcTaxiFacts } from '@shared/atc-info-boxes'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { logger } from '../logging/logger'

/** `BeyondATC.exe`'s own local port (docs/beyondatc-notes.md): `0.0.0.0:41716`, LAN-reachable, a `websocket-sharp`
 *  server. Fixed and not user-configurable on BeyondATC's side (unlike GSX's variable Remote Client port), so this is the
 *  one production callers pass. The second port BeyondATC opens, `[::1]:57700`, is an unrelated, effectively unreachable
 *  server (a bug in BeyondATC's IPv6 handling): never connect to it. */
export const BEYONDATC_PORT = 41716

/** The port an e2e test's fake BeyondATC listens on (WINGLOG_E2E_BEYONDATC_PORT): the OS picks
 *  a free one, since the real port can be taken on a CI runner. Undefined, so the real port is
 *  used, for anything that isn't a valid port.
 *
 * @param value The environment variable's value.
 * @returns The port, or undefined.
 */
export function e2eBeyondAtcPort(value: string | undefined): number | undefined {
  const port = Number(value)
  return value !== undefined && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

/** The `ws` npm package's WebSocket, not the global/`node:http` one: Node's built-in WebSocket silently drops every line
 *  after the first when BeyondATC's initial snapshot arrives as one large multi-line burst (~18 lines, including two full
 *  DATIS reports and a large Settings blob, enough to fragment across frames), which small test fixtures never exercise.
 *  `ws` reassembles it correctly. Injected so tests don't need a real BeyondATC install (like GsxRemoteService's
 *  WebSocketCtor, which has the same import preventively). */
export type WebSocketCtor = ServiceSocketCtor

// Reconnect behaviour is undesigned on BeyondATC's own side (winglog-backend's
// beyondatc-integration.md, open question 3) — reused verbatim from GsxRemoteService rather
// than invented, since it's already a reasonable "fast retry, back off if it stays down"
// shape for exactly this kind of local add-on connection.
const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 600
const RECONNECT_BACKOFF_FACTOR = 1.6

const TRANSCRIPT_LIMIT = 100

interface BeyondAtcServiceEvents {
  status: [BeyondAtcConnectionStatus]
  state: [BeyondAtcState]
  transcript: [BeyondAtcTranscriptEntry[]]
  /** Every message received and every command sent, unparsed: the dev build's capture and
   *  diagnostic log (winglog-backend robustness/dev-build.md). */
  raw: [{ direction: 'in' | 'out'; text: string }]
}

const COMMS_MODES = new Set(['queued', 'ready', 'awaiting', 'speaking', 'request', 'traffic'])

/** A VHF airband frequency as typed or picked ("118.850", "121.7"), trimmed, or null for
 *  anything else — the value is sent on BeyondATC's protocol line as-is, so it's checked
 *  rather than trusted.
 *
 * @param value Anything from the renderer.
 * @returns The frequency as text, or null.
 */
export function validFrequency(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d{3}(\.\d{1,3})?$/.test(trimmed)) return null
  const mhz = Number(trimmed)
  return mhz >= 118 && mhz < 137 ? trimmed : null
}

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

/** `InfoBoxes: [{"title", "info"}]` (real, EGLL 2026-10-05). Keeps only well-formed entries;
 *  anything else in the array is skipped rather than failing the whole list.
 *
 * @param rest The line's value, after "Key:".
 * @returns The boxes.
 */
function parseInfoBoxes(rest: string): BeyondAtcInfoBox[] {
  const value = parseJson(rest)
  if (!Array.isArray(value)) return []
  return value.filter(
    (box): box is BeyondAtcInfoBox =>
      typeof box === 'object' &&
      box !== null &&
      typeof (box as { title?: unknown }).title === 'string' &&
      typeof (box as { info?: unknown }).info === 'string'
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
 *  (missing separator) parses to null rather than a half-populated guess.
 *
 * @param rest The line's value, after "Key:".
 * @returns The facility, or null.
 */
function parseFacility(rest: string): BeyondAtcFacility | null {
  const sep = rest.indexOf('|')
  if (sep < 0) return null
  return { name: rest.slice(0, sep).trim(), frequency: rest.slice(sep + 1).trim() }
}

/** `Actions: [Label¬Label¬...¬]` — bracket-wrapped, `¬`-separated plain labels, confirmed
 *  live NOT to be JSON despite the `[...]` syntax (docs/beyondatc-notes.md). A trailing `¬`
 *  before the close bracket is normal (BeyondATC's own "Fire Action 1/2/3" numbering) and
 *  produces a trailing empty entry, filtered out here. `[]` (no menu offered) parses to [].
 *
 * @param rest The line's value, after "Key:".
 * @returns The action labels.
 */
function parseActions(rest: string): string[] {
  const trimmed = rest.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
  const inner = trimmed.slice(1, -1)
  if (inner === '') return []
  return inner.split('¬').filter((label) => label !== '')
}

/** `AutoTune`/`AutoRespond: <bool>` — bare lowercase `true`/`false`, confirmed live
 *  2026-09-29 (a real capture, not the notes doc's earlier unquoted `<bool>` placeholder).
 *  Anything else (unexpected casing, a malformed push) resolves to `null` rather than a
 *  guess, same defensive-parser discipline as parseFacility.
 *
 * @param rest The line's value, after "Key:".
 * @returns The value, or null.
 */
function parseBool(rest: string): boolean | null {
  const trimmed = rest.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  return null
}

function isFrequencyOption(value: unknown): value is BeyondAtcFrequencyOption {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.airport === 'string' &&
    typeof v.airportName === 'string' &&
    typeof v.frequency === 'string' &&
    typeof v.name === 'string' &&
    typeof v.type === 'string' &&
    typeof v.stationType === 'string' &&
    typeof v.runways === 'string' &&
    (v.cpdlcLogonCode === undefined || typeof v.cpdlcLogonCode === 'string')
  )
}

/** `Frequencies: [...]` — confirmed live 2026-09-29, the real response to the `frequencies`
 *  command (docs/beyondatc-notes.md), not the local-UI-only no-op it was previously
 *  suspected to be. Unlike `Actions`, this genuinely is a JSON array. Any entry that doesn't
 *  match the confirmed shape is dropped rather than surfacing a half-parsed option.
 *
 * @param rest The line's value, after "Key:".
 * @returns The frequencies.
 */
function parseFrequencies(rest: string): BeyondAtcFrequencyOption[] {
  const value = parseJson(rest)
  if (!Array.isArray(value)) return []
  return value.filter(isFrequencyOption)
}

/**
 * Owns the live WebSocket connection to `BeyondATC.exe`'s own local server (winglog-backend's
 * docs/plans/beyondatc-integration.md; protocol findings in docs/beyondatc-notes.md). Parses BeyondATC's plain-text
 * `Key: value`/`Key: <JSON>` line protocol, a different wire shape from GSX Remote Control's JSON-envelope
 * snapshot/patch messages, even though the rest of this class (constructor, start/stop, reconnect, event emitter) mirrors
 * GsxRemoteService. Surfaces the transcript, live facility/com2/callsign/commsState/progress, Actions, AutoTune/AutoRespond
 * and the Frequencies list, with the set_action, set_frequency, set_autotune and set_autorespond commands. Everything else in the
 * wire catalogue (DATIS, CPDLC code, settings, …) is deliberately never reflected in getState().
 */
export class BeyondAtcService extends EventEmitter<BeyondAtcServiceEvents> {
  private ws: ServiceSocket | undefined
  private stopped = true
  private reconnectTimer: NodeJS.Timeout | undefined
  private lastFrequencyRequest = 0
  private backoffMs = RECONNECT_MIN_MS
  private status: BeyondAtcConnectionStatus = { state: 'disconnected', lastError: null }

  private state: BeyondAtcState = { ...EMPTY_BEYONDATC_STATE }
  private transcript: BeyondAtcTranscriptEntry[] = []

  constructor(
    private host: string,
    private readonly port: number = BEYONDATC_PORT,
    private readonly WebSocketImpl: WebSocketCtor = NodeServiceSocket
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
   *  guard `sendCommand` below already enforces. The label comes from the renderer (and, in
   *  future, a LAN client), which isn't a security boundary: it must be one of the actions
   *  BeyondATC is offering right now, so nothing else can be typed onto its protocol line.
   *
   * @param label The action's label, from the renderer.
   */
  setAction(label: unknown): void {
    if (typeof label !== 'string' || !this.state.actions.includes(label)) return
    this.sendCommand(`set_action: ${label}`)
  }

  setFrequency(frequency: unknown): void {
    const valid = validFrequency(frequency)
    if (valid) this.sendCommand(`set_frequency: ${valid}`)
  }

  setFrequencyCom2(frequency: unknown): void {
    const valid = validFrequency(frequency)
    if (valid) this.sendCommand(`set_frequency_com2: ${valid}`)
  }

  /** Confirmed working two-way control, 2026-09-29 (docs/beyondatc-notes.md) — sends the
   *  real `set_autotune`/`set_autorespond` command, value lowercased by template
   *  interpolation same as the confirmed wire format expects.
   *
   * @param value Whether BeyondATC tunes the radios itself.
   */
  setAutoTune(value: unknown): void {
    if (typeof value === 'boolean') this.sendCommand(`set_autotune: ${value}`)
  }

  setAutoRespond(value: unknown): void {
    if (typeof value === 'boolean') this.sendCommand(`set_autorespond: ${value}`)
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
   *  never changes (BEYONDATC_PORT is fixed), unlike GsxRemoteService's reconfigure.
   *
   * @param host BeyondATC's host.
   */
  reconfigure(host: string): void {
    this.host = host
    this.state = { ...EMPTY_BEYONDATC_STATE }
    this.transcript = []
    if (!this.stopped) {
      this.ws?.close()
      this.connect()
    }
  }

  private sendCommand(text: string): void {
    // Every command is one line of BeyondATC's text protocol.
    if (/[\r\n]/.test(text)) return
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(text)
    this.emit('raw', { direction: 'out', text })
  }

  /** The list is empty if asked before BeyondATC has a flight loaded (real report,
   *  2026-09-29: picker empty when WingLog connected first, fine after a manual off/on).
   *  So it's re-asked whenever facility/progress arrives while still empty, and whenever the
   *  origin/destination changes. Throttled so a burst of state lines sends one request.
   *
   * @param force Ask even within the throttle.
   */
  private requestFrequencies(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastFrequencyRequest < 2000) return
    this.lastFrequencyRequest = now
    this.sendCommand('frequencies')
  }

  private setStatus(status: BeyondAtcConnectionStatus): void {
    this.status = status
    this.emit('status', status)
  }

  /**
   * Opens the WebSocket to BeyondATC and wires its open, message, close and error events. A failed or
   * dropped connection schedules a reconnect.
   */
  private connect(): void {
    if (this.stopped) return
    this.setStatus({ state: 'connecting', lastError: null })

    let socket: ServiceSocket
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
      // Proactively requested, not part of the initial snapshot — confirmed live
      // 2026-09-29 (docs/beyondatc-notes.md), a real bare command with no value/colon.
      this.requestFrequencies(true)
    })

    socket.addEventListener('message', (event: { data: unknown }) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data)
      this.emit('raw', { direction: 'in', text: raw })
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

  // What each line's key does with its value. Any other key BeyondATC sends (DATIS, CPDLCCode,
  // RadioMute, LoadState, Settings, ToolbarVersion, QueuedAction, DATIS_END) is ignored.
  private readonly lineHandlers = new Map<string, (rest: string) => void>([
    [
      'Facility',
      (rest) => {
        this.setState({ facility: parseFacility(rest) })
        if (this.state.frequencies.length === 0) this.requestFrequencies()
      }
    ],
    ['Com2', (rest) => this.setParsed(rest, isCom2, (com2) => ({ com2 }))],
    ['Callsign', (rest) => this.setParsed(rest, isCallsign, (callsign) => ({ callsign }))],
    ['CommsState', (rest) => this.setParsed(rest, isCommsState, (commsState) => ({ commsState }))],
    ['Progress', (rest) => this.onProgress(rest)],
    ['Actions', (rest) => this.setState({ actions: parseActions(rest) })],
    ['AutoTune', (rest) => this.setState({ autoTune: parseBool(rest) })],
    ['AutoRespond', (rest) => this.setState({ autoRespond: parseBool(rest) })],
    ['Frequencies', (rest) => this.setState({ frequencies: parseFrequencies(rest) })],
    ['InfoBoxes', (rest) => this.onInfoBoxes(rest)],
    ['Player', (rest) => this.pushTranscript('player', rest)],
    ['ATC', (rest) => this.pushTranscript('atc', rest)],
    ['Traffic', (rest) => this.pushTranscript('traffic', rest)],
    ['ATCTraffic', (rest) => this.pushTranscript('atcTraffic', rest)]
  ])

  /**
   * One `Key: value` line of BeyondATC's protocol.
   *
   * @param line The line, without its line break.
   */
  private handleLine(line: string): void {
    if (line.trim() === '') return
    const sep = line.indexOf(':')
    if (sep < 0) return
    this.lineHandlers.get(line.slice(0, sep).trim())?.(line.slice(sep + 1).trim())
  }

  /**
   * Updates the state and tells listeners.
   *
   * @param patch The fields that changed.
   */
  private setState(patch: Partial<BeyondAtcState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }

  /**
   * A JSON value: applied when it has the expected shape, ignored otherwise.
   *
   * @param rest The line's value.
   * @param isValid Checks the parsed value's shape.
   * @param patch The state fields it sets.
   */
  private setParsed<T>(
    rest: string,
    isValid: (value: unknown) => value is T,
    patch: (value: T) => Partial<BeyondAtcState>
  ): void {
    const value = parseJson(rest)
    if (isValid(value)) this.setState(patch(value))
  }

  /**
   * `Progress`: the route and how far along it. A new route, or one arriving before the
   * frequencies, asks for the frequency list again.
   *
   * @param rest The line's value.
   */
  private onProgress(rest: string): void {
    const value = parseJson(rest)
    if (!isProgress(value)) return
    const prev = this.state.progress
    this.setState({ progress: value })
    if (this.state.frequencies.length === 0 || prev?.from !== value.from || prev?.to !== value.to) {
      this.requestFrequencies()
    }
  }

  /**
   * `InfoBoxes`: the facts BeyondATC shows, and the gate they assign. Each change is logged raw to
   * main.log, which the simulations read back (scripts/sim/local-data.ts).
   *
   * @param rest The line's value.
   */
  private onInfoBoxes(rest: string): void {
    const infoBoxes = parseInfoBoxes(rest)
    const changed = JSON.stringify(infoBoxes) !== JSON.stringify(this.state.infoBoxes)
    if (changed) logger.info(`[beyondatc] InfoBoxes ${rest}`)
    this.setState({
      infoBoxes,
      infoBoxesAt: changed ? Date.now() : this.state.infoBoxesAt,
      assignedGate: assignedGate(parseAtcTaxiFacts(infoBoxes)) ?? this.state.assignedGate
    })
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
