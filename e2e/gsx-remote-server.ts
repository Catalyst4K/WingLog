import { WebSocketServer, type WebSocket } from 'ws'

/**
 * A minimal stand-in for GSX Pro's real Remote Client WebSocket server, for driving the
 * GSX tab and the global important-menu dialog through a real launched app without a real
 * MSFS + GSX install — same "real protocol, fake transport" shape as `ReplaySimConnectService`
 * (flight-replay-harness.md), but for `GsxRemoteService`'s WebSocket instead of SimConnect.
 *
 * All payloads below are real captures, not invented shapes — see flightdeck-backend's
 * docs/gsx-notes.md (round 6/7 for the gate/service `detail` fields, the pushback-direction
 * menu capture for the important-menu dialog). `GsxRemoteService` only ever sends one
 * `{type:"subscribe",...}` message on open and ignores anything else it doesn't recognise
 * (confirmed by reading its own `handleMessage`), so this fake never needs to implement GSX's
 * `hello`/`result` handshake for the client to work — it's omitted here deliberately, not
 * forgotten.
 */
export class FakeGsxRemoteServer {
  private wss: WebSocketServer
  private sockets = new Set<WebSocket>()
  readonly receivedCommands: { verb: string; args?: Record<string, unknown> }[] = []
  private connectionWaiters: (() => void)[] = []

  private constructor(wss: WebSocketServer) {
    this.wss = wss
    wss.on('connection', (socket) => {
      this.sockets.add(socket)
      for (const resolve of this.connectionWaiters.splice(0)) resolve()
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('message', (raw: Buffer) => {
        let message: unknown
        try {
          message = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'command'
        ) {
          const { verb, args } = message as { verb: string; args?: Record<string, unknown> }
          this.receivedCommands.push({ verb, args })
        }
      })
    })
  }

  static async start(): Promise<FakeGsxRemoteServer> {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    return new FakeGsxRemoteServer(wss)
  }

  /** Resolves once GsxRemoteService's socket has actually connected — the test drives this
   *  explicitly (enable GSX Remote in Settings, then await this) rather than sending a
   *  snapshot on a timer and hoping the client is ready by then. */
  waitForConnection(): Promise<void> {
    if (this.sockets.size > 0) return Promise.resolve()
    return new Promise((resolve) => this.connectionWaiters.push(resolve))
  }

  get port(): number {
    const address = this.wss.address()
    if (typeof address === 'string' || address === null) throw new Error('server not listening on a TCP port')
    return address.port
  }

  /** Sends a `snapshot` (the full state, as GSX sends once right after `subscribe`) to every
   *  currently-connected socket — good enough for these tests, which each connect exactly
   *  one client. */
  sendSnapshot(state: Record<string, unknown>): void {
    this.broadcast({ type: 'snapshot', ...state })
  }

  /** Sends a `patch` — GSX's own shape for updating one top-level state key after the initial
   *  snapshot (`{type:"patch", path:"/menu", value:...}`). */
  sendPatch(path: string, value: unknown): void {
    this.broadcast({ type: 'patch', path, value })
  }

  private broadcast(message: unknown): void {
    const json = JSON.stringify(message)
    for (const socket of this.sockets) socket.send(json)
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.close()
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()))
    })
  }
}

/** A real VHHH boot snapshot, confirmed live (docs/gsx-notes.md, round 6/7) — gate resolved,
 *  a couple of real services (an active primary one with structured billing detail, an idle
 *  secondary one to exercise the "show more" fold), no menu open yet. */
export const VHHH_BOOT_SNAPSHOT = {
  airport: { icao: 'VHHH', name: 'Hong Kong Intl', country: 'Hong Kong' },
  parking: '(N) T1 North|Gate N6',
  gateProperties: ['Gate Heavy', 'SafeDockT42', 'jetway', 'underground fuel', 'no stairs', 'no bus', 'max wingspan 70m'],
  services: [
    {
      id: 'Refueling',
      displayName: 'Refuel',
      state: 'performing',
      stateText: 'Refueling service is being performed',
      icon: 'refueling',
      canTrigger: false,
      canBypass: false,
      operator: 'AFSC',
      statusText: 'pumping\nfuel 15357/81488 kg\naircraft 15606→30963 kg\nBill $24272',
      progressText: '19%',
      detail: {
        phase: 'pumping',
        fuel: { current: 15357, target: 81488, unit: 'kg', startTotal: 15606, aircraftTotal: 30963 },
        bill: 24272
      }
    },
    {
      id: 'GPU',
      displayName: 'GPU',
      state: 'available',
      stateText: '',
      icon: 'gpu',
      canTrigger: true,
      canBypass: false,
      statusText: '',
      progressText: ''
    }
  ],
  menu: { title: '', header: '', subtitle: '', entries: [], icons: [], disabled: [], layout: '' },
  menuShown: false,
  prompt: null,
  // Real command-bar keys, confirmed live 2026-09-23 by reading GSX's own shipped menu.js
  // source (STATIC_COMMANDS' ids) and capturing a real commandIcons/simbrief snapshot.
  commandIcons: {
    CUSTOMIZE_AIRPORT_POSITION: 'data:image/png;base64,AAA',
    CUSTOMIZE_AIRPLANE: 'data:image/png;base64,BBB',
    SETTINGS: 'data:image/png;base64,CCC',
    RESTART_COUATL: 'data:image/png;base64,DDD',
    RELOAD_SIMBRIEF: 'data:image/png;base64,EEE'
  },
  simbrief: { status: 'loaded', error: '', gen: 0 }
}

/** The real pushback-direction menu, confirmed live (docs/gsx-notes.md) — one of only two
 *  menus `isImportantGsxMenu` treats as important enough to interrupt the whole app. */
export const PUSHBACK_DIRECTION_MENU = {
  title: 'Select pushback direction',
  header: 'Select pushback direction',
  subtitle: '',
  layout: 'list',
  icons: [],
  entries: [
    'RED - Facing South onto B9',
    'BLUE - Facing East onto B7',
    'QuickEdit Pushback',
    'QuickEdit Pushback on Map',
    'Straight pushback (manual stop, max 100 m)',
    'Straight Pull pushback (manual stop, max 100 m)'
  ],
  disabled: [false, false, false, false, false, false]
}
