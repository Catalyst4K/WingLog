/** BeyondATC: its settings, connection and the live state WingLog reads from it. */

/**
 * BeyondATC integration — a live control link to `BeyondATC.exe`'s own local WebSocket
 * server (winglog-backend's docs/plans/beyondatc-integration.md; real protocol findings
 * in docs/beyondatc-notes.md, confirmed live 2026-09-25). Unlike GSX's Remote Client, the
 * port is fixed (`41716`, confirmed on BeyondATC's own side, not user-configurable) — only
 * `host` and `enabled` are real settings.
 */
export interface BeyondAtcSettings {
  enabled: boolean
  host: string
}

export type BeyondAtcConnectionState = 'disconnected' | 'connecting' | 'connected'

export interface BeyondAtcConnectionStatus {
  state: BeyondAtcConnectionState
  /** Set only when state is 'disconnected' after a real connection attempt failed. */
  lastError: string | null
}

/** `Facility: <name>|<frequency>` — the station BeyondATC currently has the pilot tuned
 *  to on COM1, confirmed live (docs/beyondatc-notes.md). */
export interface BeyondAtcFacility {
  name: string
  frequency: string
}

/** `Com2: {"label","frequency","monitor"}`, confirmed live. */
export interface BeyondAtcCom2 {
  label: string
  frequency: string
  monitor: boolean
}

/** `Callsign: {"full","shortForm"}`, confirmed live. */
export interface BeyondAtcCallsign {
  full: string
  shortForm: string
}

/** `CommsState: {"mode","text"}` — the live interaction lifecycle (queued → ready →
 *  awaiting response → speaking → request logged → ready), confirmed live via a real
 *  Radio Check trace (docs/beyondatc-notes.md). Drives the panel's "who's talking/awaiting"
 *  indicator, same idea as GSX Remote's own status badge. */
export interface BeyondAtcCommsState {
  mode: 'queued' | 'ready' | 'awaiting' | 'speaking' | 'request' | 'traffic'
  text: string
}

/** `Progress: {"from","to","pct"}`, confirmed live. */
export interface BeyondAtcProgress {
  from: string
  to: string
  pct: number
}

/** One entry of the real `Frequencies: [...]` response to the `frequencies` command —
 *  confirmed live 2026-09-29 (winglog-backend's docs/beyondatc-notes.md), a genuine
 *  structured station list for every airport in the flight plan, not the local-UI-only
 *  no-op it was previously suspected to be. `airport`/`airportName`/`stationType`/`runways`
 *  are sometimes empty strings (the one real enroute Center entry captured had no airport
 *  tied to it); `cpdlcLogonCode` was only ever present on that same entry, so it's optional. */
export interface BeyondAtcFrequencyOption {
  airport: string
  airportName: string
  frequency: string
  name: string
  type: string
  stationType: string
  runways: string
  cpdlcLogonCode?: string
}

/** ATC's arrival clearance as last given, kept until touchdown for the BeyondATC tab's info
 *  card (src/main/beyondatc/arrival-clearance.ts). The STAR and runway come from a STAR
 *  clearance, the approach and transition from an approach clearance or "expect" line. */
export interface BeyondAtcArrivalClearance {
  starIdent: string | null
  runway: string | null
  approachIdent: string | null
  approachTransition: string | null
}

/** WingLog's own BeyondATC auto step climb (winglog-backend's docs/plans/
 *  beyondatc-auto-step-climb.md) — not a BeyondATC setting; WingLog asks for each new level. */
export interface BeyondAtcStepClimbStatus {
  enabled: boolean
  /** The next SimBrief step above the cleared level, while tracking an OFP flight. */
  nextStep: { ident: string; altitudeFt: number; distanceNm: number } | null
  /** A request in progress, by level in feet. */
  pendingAltitudeFt: number | null
  /** An FCU level not in the plan, held back until the aircraft is actually climbing to it. */
  waitingForClimbFt: number | null
  /** Past SimBrief's top of descent — nothing more is asked for this flight. */
  pastTopOfDescent: boolean
  last: {
    altitudeFt: number
    outcome: 'granted' | 'unavailable' | 'noMenu' | 'notOffered' | 'noAnswer'
    attempt: number
    reason: 'simbrief' | 'fcu'
    /** Two failures — this level won't be asked for again this flight. */
    dropped: boolean
  } | null
}

/** Combined live state BeyondAtcPanel needs — deliberately narrower than every key
 *  docs/beyondatc-notes.md catalogues (DATIS, CPDLC code, settings, … aren't surfaced here;
 *  nothing needed by this panel). Unrecognised/unparsed wire keys are simply never reflected
 *  here, not an error. */
export interface BeyondAtcState {
  facility: BeyondAtcFacility | null
  com2: BeyondAtcCom2 | null
  callsign: BeyondAtcCallsign | null
  commsState: BeyondAtcCommsState | null
  progress: BeyondAtcProgress | null
  /** The live `Actions` menu — bracket/`¬`-separated plain labels on the wire (confirmed
   *  live, NOT JSON despite the `[...]` syntax), parsed into a plain string list. Empty
   *  when BeyondATC currently has no menu offered. */
  actions: string[]
  /** `AutoTune`/`AutoRespond: <bool>` — bare lowercase `true`/`false` on the wire (confirmed
   *  live 2026-09-29, not JSON, not `True`/`False`), null until the first snapshot arrives.
   *  `set_autotune`/`set_autorespond` (below) are confirmed working two-way control, same
   *  live session. */
  autoTune: boolean | null
  autoRespond: boolean | null
  /** Populated from the real `Frequencies` response — see `BeyondAtcFrequencyOption`. Empty
   *  until `BeyondAtcService` requests it right after connecting. */
  frequencies: BeyondAtcFrequencyOption[]
  /** `InfoBoxes: [{"title", "info"}]`, the facts BeyondATC's own menu shows. Seen live at
   *  EGLL: "Taxi to Gate" / "Gate 411", "Taxi Via 1".."Taxi Via 7"
   *  (one taxiway each, "LINK 44" included), "ATIS Current" / "C". The gate is set here as
   *  soon as BeyondATC assigns it, before ATC ever says it. Empty until the first push. */
  infoBoxes: BeyondAtcInfoBox[]
  /** When `infoBoxes` last changed (ms since epoch), or null before any have arrived. */
  infoBoxesAt: number | null
  /** The last gate BeyondATC's InfoBoxes assigned (`Expect Gate` / `Taxi to Gate`, label
   *  removed: '102'). Kept after the box set is replaced, until the next assignment or a new
   *  connection, so GSX's gate search can still offer it at the gate. */
  assignedGate: string | null
}

/** One of BeyondATC's `InfoBoxes` entries: a label and its value, both free text. */
export interface BeyondAtcInfoBox {
  title: string
  info: string
}

/** One live transcript line — `Player`/`ATC` are the pilot/controller's own spoken lines;
 *  `Traffic`/`ATCTraffic` are an AI aircraft's own radio calls and ATC's response to them.
 *  Kept as a bounded ring buffer by BeyondAtcService (last 100), not persisted. */
export interface BeyondAtcTranscriptEntry {
  speaker: 'player' | 'atc' | 'traffic' | 'atcTraffic'
  text: string
  ts: number
}
