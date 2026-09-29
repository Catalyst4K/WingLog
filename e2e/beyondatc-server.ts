import { WebSocketServer, type WebSocket } from 'ws'

/** Must match `BeyondAtcService`'s own `BEYONDATC_PORT` (`src/main/beyondatc/
 *  BeyondAtcService.ts`) — BeyondATC's real port is fixed, not user-configurable, so unlike
 *  `FakeGsxRemoteServer` (which binds an ephemeral port because GSX's Remote Client port
 *  genuinely varies) this fake binds the literal real port. */
export const BEYONDATC_PORT = 41716

/**
 * A minimal stand-in for `BeyondATC.exe`'s own real local WebSocket server, for driving the
 * BeyondATC tab through a real launched app without a real MSFS + BeyondATC install — same
 * "real protocol, fake transport" shape as `FakeGsxRemoteServer`, but BeyondATC's own
 * plain-text `Key: value` line protocol instead of GSX's JSON envelopes. All lines sent below
 * are real captures, not invented shapes — see flightdeck-backend's docs/beyondatc-notes.md.
 */
export class FakeBeyondAtcServer {
  private wss: WebSocketServer
  private sockets = new Set<WebSocket>()
  readonly receivedCommands: string[] = []
  private connectionWaiters: (() => void)[] = []

  private constructor(wss: WebSocketServer) {
    this.wss = wss
    wss.on('connection', (socket) => {
      this.sockets.add(socket)
      for (const resolve of this.connectionWaiters.splice(0)) resolve()
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('message', (raw: Buffer) => {
        this.receivedCommands.push(raw.toString())
      })
    })
  }

  static async start(): Promise<FakeBeyondAtcServer> {
    const wss = new WebSocketServer({ port: BEYONDATC_PORT })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    return new FakeBeyondAtcServer(wss)
  }

  /** Resolves once BeyondAtcService's socket has actually connected — the test drives this
   *  explicitly (enable BeyondATC in Settings, then await this) rather than sending lines on
   *  a timer and hoping the client is ready by then. */
  waitForConnection(): Promise<void> {
    if (this.sockets.size > 0) return Promise.resolve()
    return new Promise((resolve) => this.connectionWaiters.push(resolve))
  }

  /** Sends one or more `Key: value` lines, newline-joined in a single push — matches how a
   *  real BeyondATC snapshot arrives as several lines together. */
  sendLines(...lines: string[]): void {
    const text = lines.join('\n')
    for (const socket of this.sockets) socket.send(text)
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.close()
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()))
    })
  }
}

/** A real Radio Check trace, confirmed live against BeyondATC's own WebSocket
 *  (flightdeck-backend's docs/beyondatc-notes.md, "A real, observed success trace"). */
export const RADIO_CHECK_SNAPSHOT = [
  'Facility: Brisbane Delivery|118.850',
  'Callsign: {"full": "Cathay 116 Heavy", "shortForm": "CPA116"}',
  'Actions: [Request IFR Clearance¬Request Departure Runway Change¬Radio Check¬]'
]

export const RADIO_CHECK_RESPONSE = [
  'CommsState: {"mode": "awaiting", "text": "Awaiting Response"}',
  'Player: Cathay 116 Heavy, radio check.',
  'CommsState: {"mode": "speaking", "text": "Speaking"}',
  'ATC: Cathay 116 Heavy, readability 5.',
  'CommsState: {"mode": "ready", "text": ""}'
]

/** `AutoTune`/`AutoRespond`'s real wire format — bare lowercase `true`/`false`, confirmed
 *  live 2026-09-29 (flightdeck-backend's docs/beyondatc-notes.md). */
export const AUTO_SETTINGS_SNAPSHOT = ['AutoTune: true', 'AutoRespond: false']

/** A trimmed real response to the `frequencies` command (2 of ~29 real entries from one
 *  live capture, 2026-09-29) — enough to exercise the picker without pasting the whole
 *  real station list into a test fixture. Field shapes are verbatim, not invented. */
export const FREQUENCIES_RESPONSE = [
  'Frequencies: [{"airport":"WSSS","airportName":"Changi","frequency":"124.050","name":"SINGAPORE APPROACH","type":"Approach","stationType":"","runways":"02L"},' +
    '{"airport":"","airportName":"","frequency":"134.400","name":"Singapore Radar","type":"Center","stationType":"","runways":""}]'
]
