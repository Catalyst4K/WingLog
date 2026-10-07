import { WebSocketServer, type WebSocket } from 'ws'

/** The app's BeyondATC port for this launch: the fake binds whatever port the OS hands out and
 *  passes it in through this variable. BeyondATC's real port (41716) is inside Linux's ephemeral
 *  range, so binding it on a CI runner could fail when any outgoing connection had it. */
export const BEYONDATC_PORT_ENV = 'WINGLOG_E2E_BEYONDATC_PORT'

/**
 * A minimal stand-in for `BeyondATC.exe`'s own real local WebSocket server, for driving the
 * BeyondATC tab through a real launched app without a real MSFS + BeyondATC install — same
 * "real protocol, fake transport" shape as `FakeGsxRemoteServer`, but BeyondATC's own
 * plain-text `Key: value` line protocol instead of GSX's JSON envelopes. All lines sent below
 * are real captures, not invented shapes — see winglog-backend's docs/beyondatc-notes.md.
 */
export class FakeBeyondAtcServer {
  private wss: WebSocketServer
  private sockets = new Set<WebSocket>()
  readonly receivedCommands: string[] = []
  private connectionWaiters: (() => void)[] = []

  /** Pass to launchApp's `env`, so the app connects to this fake. */
  readonly env: Record<string, string>

  private constructor(wss: WebSocketServer) {
    this.wss = wss
    const address = wss.address()
    this.env = {
      [BEYONDATC_PORT_ENV]: String(typeof address === 'object' && address !== null ? address.port : 0)
    }
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
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
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
 *  (winglog-backend's docs/beyondatc-notes.md, "A real, observed success trace"). */
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
 *  live 2026-09-29 (winglog-backend's docs/beyondatc-notes.md). */
export const AUTO_SETTINGS_SNAPSHOT = ['AutoTune: true', 'AutoRespond: false']

/** A trimmed real response to the `frequencies` command (2 of ~29 real entries from one
 *  live capture, 2026-09-29) — enough to exercise the picker without pasting the whole
 *  real station list into a test fixture. Field shapes are verbatim, not invented. */
export const FREQUENCIES_RESPONSE = [
  'Frequencies: [{"airport":"WSSS","airportName":"Changi","frequency":"124.050","name":"SINGAPORE APPROACH","type":"Approach","stationType":"","runways":"02L"},' +
    '{"airport":"","airportName":"","frequency":"134.400","name":"Singapore Radar","type":"Center","stationType":"","runways":""}]'
]

/**
 * A real, full-size initial-connect snapshot — confirmed live, 2026-09-28, against Callum's
 * actual BeyondATC session (winglog-backend's docs/beyondatc-notes.md). Deliberately kept
 * this big and this shaped (two full DATIS reports plus a large Settings blob, ~18 lines,
 * pushed as one combined message): a real, previously-invisible bug — Node's built-in global
 * WebSocket silently drops every line after the first when a message this size arrives as one
 * multi-line burst, something `RADIO_CHECK_SNAPSHOT` above (three short lines) never
 * exercises. `BeyondAtcService` now uses the `ws` npm package instead, which reassembles it
 * correctly. This fixture exists specifically so a regression here fails a real test, not just
 * a live session.
 */
export const LARGE_REAL_SNAPSHOT = [
  'Facility: Singapore Delivery|121.650',
  'CPDLCCode: ',
  'AutoTune: true',
  'AutoRespond: true',
  'Actions: [Request IFR Clearance¬Request Departure Runway Change¬Radio Check¬]',
  'DATIS: WSSS|B|WSSS ATIS B 2115Z 35002KT 3000 HZ FEW018 BKN270 27/26 Q1012 ARR RWY 20 RIGHT DEP RWY 20 CENTER TRANSITION-LEVEL FL130 ACKNOWLEDGE RECEIPT OF INFORMATION B AND ADVISE AIRCRAFT TYPE ON FIRST CONTACT ',
  'DATIS: ZSPD|J|ZSPD ATIS J 2116Z 09005MPS 030V100 9999 OVC040 24/21 Q1012 ARR RWY 16 RIGHT 17 RIGHT DEP RWY 16 RIGHT 17 LEFT TRANSITION-LEVEL 3600M BIRD ACTIVITY REPORTED ACKNOWLEDGE RECEIPT OF INFORMATION J AND ADVISE AIRCRAFT TYPE ON FIRST CONTACT ',
  'DATIS_END:',
  'QueuedAction: ',
  'InfoBoxes: [{"title":"ATIS Current","info":"B"}]',
  'Com2: {"label":"Radio Off","frequency":"","monitor":false}',
  'RadioMute: {"com1":true,"com2":true}',
  'Progress: {"from":"WSSS","to":"ZSPD","pct":0.0}',
  'LoadState: {"stage":"ready","text":"","pct":-1,"vfr":false,"loggedIn":true}',
  'Callsign: {"full":"Singapore 830 Super","shortForm":""}',
  'ToolbarVersion: 3.1',
  'Settings: {"voiceVolume":82,"uiSounds":true,"controllerVoice":"Local","trafficVoice":"Local","trafficOn":true,"parkedDensity":8,"departuresDensity":7,"arrivalsDensity":7,"enrouteDensity":5,"navigraphLiveTraffic":true,"navigraphLinked":true,"navigraphUltimate":true,"taxiArrowsShown":false,"simIs2024":true,"dynamicVoiceOn":false,"dynamicVoiceGender":0,"autoRespondVoice":2,"autoRespondVoiceOptions":["US Male","US Female","UK Male","UK Female","AU Male","Jeff Favignano (Premium Only)","CivRyan (Premium Only)","Squirrel (Premium Only)","EasyJetSimPilot (Premium Only)","British Avgeek (Premium Only)","Overkill (Premium Only)","FlyBy Simulations (Premium Only)","V1-Simulations (Premium Only)","FSFO English1 (Premium Only)","FS2Crew US Stephanie (Premium Only)"],"voiceQualityOptions":[{"value":"Off","label":"Off (No Cost)"},{"value":"Local","label":"Local (No Cost)"},{"value":"Premium","label":"Premium (Higher Cost)"}],"voiceGenderOptions":[{"value":"0","label":"Any"},{"value":"1","label":"Female"},{"value":"2","label":"Male"}],"premiumUnits":1908,"premiumUnitsMax":50000}'
]
