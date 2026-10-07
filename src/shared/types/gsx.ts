/** GSX: matched receipts, receipt settings, and GSX Remote's live state and commands. */

export type GsxServiceGroup = 'catering' | 'fuel' | 'handling' | 'passengerBus'

/** A matched GSX ground-service receipt, snapshotted at flight completion rather than
 *  read live — see docs/decisions.md's gsx-invoices entry for why. */
export interface FlightInvoice {
  id: number
  flightId: number
  serviceGroup: GsxServiceGroup
  receiptId: string
  issuedUtc: string
  icao: string
  tail: string
  operator: string | null
  /** USD equivalent GSX computed itself — the only side safe to sum across receipts that
   *  may be in different currencies (docs/gsx-notes.md). Null if the receipt's total
   *  couldn't be parsed. */
  totalUsd: number | null
  /** The original local-currency string, shown verbatim — never reformatted or re-derived. */
  totalText: string | null
  /** Path to the original styled .html receipt — "Open receipt" opens this directly.
   *  May no longer exist if GSX's own admin UI bulk-deleted it; the stored data above
   *  still renders regardless. */
  sourceHtmlPath: string
  /** The full receipt JSON (logoDataUri stripped before storage) — service info rows,
   *  line items, taxes, fx disclosure. Parsed client-side for display. */
  receiptJson: string
}

/** A NOTAIL receipt near a flight's window/airport — not confidently matched (no tail to
 *  compare), so offered for manual attach rather than auto-stored. */
export interface GsxNotailCandidate {
  serviceGroup: GsxServiceGroup
  jsonPath: string
  issuedUtc: string
  icao: string
}

export interface GsxRescanResult {
  invoices: FlightInvoice[]
  notailCandidates: GsxNotailCandidate[]
}

export interface GsxSettings {
  enabled: boolean
  folderPath: string | null
  // ISO 4217 code GSX totals are converted to and displayed in, via a live rate
  // (fxGetRate) — 'USD' means no conversion, matching GSX's own totalUsd field verbatim.
  displayCurrency: string
}

/**
 * GSX Remote Control — a live control link to GSX Pro's own "Remote Client" WebSocket
 * (winglog-backend's docs/plans/gsx-remote-control.md; real findings in docs/gsx-notes.md).
 * Unrelated to GsxSettings above, which is the file-based receipts feature. Port is
 * genuinely user-configurable in GSX's own settings — never assume a default is correct.
 */
export interface GsxRemoteSettings {
  enabled: boolean
  host: string
  port: number | null
}

export type GsxRemoteConnectionState = 'disconnected' | 'connecting' | 'connected'

export interface GsxRemoteConnectionStatus {
  state: GsxRemoteConnectionState
  /** Set only when state is 'disconnected' after a real connection attempt failed. */
  lastError: string | null
}

/** Per-service structured progress/billing, from GSX's `state.services[].detail`: every field is service-specific and
 *  optional, since a service only populates the fields it has. Shapes seen in real captures (docs/gsx-notes.md, rounds 6/7):
 *  Refueling (`fuel`/`bill`) and Boarding (`pax`/`cargo`). Used to format fuel and boarding progress numerically instead of
 *  re-parsing `statusText`'s free text. */
export interface GsxRemoteServiceDetail {
  phase?: string
  /** Free-text blocking conditions ("BaggageTrainEmptyFront to clear the way"), present only while GSX is stuck on
   *  something (docs/gsx-notes.md, round 11: a Boarding session hitting a vehicle-pathing conflict). Shown alongside whichever
   *  other `detail` fields are present (e.g. `pax`), not instead of them: GSX keeps reporting real counts while waiting. */
  waitingFor?: string[]
  fuel?: {
    current: number
    target: number
    unit: string
    startTotal: number
    aircraftTotal: number
  }
  /** A live running bill for this service, in USD (`detail.bill: 24272` matches "Bill $24272" in the same message's
   *  `statusText`). Present once GSX starts billing the service, absent before then. */
  bill?: number
  pax?: { done: number; total: number }
  cargo?: {
    hold: string
    unit: string
    done: number
    total: number
    trip: number
    trips: number
    train: string
  }[]
}

/** One entry of GSX's `state.services`: read-only status, not the control surface (that's GsxRemoteMenuState below). Field
 *  names and shapes are GSX's wire format verbatim (docs/gsx-notes.md). */
export interface GsxRemoteServiceStatus {
  id: string
  displayName: string
  state: string
  stateText: string
  icon: string
  canTrigger: boolean
  canBypass: boolean
  operator?: string
  statusText: string
  progressText: string
  detail?: GsxRemoteServiceDetail
}

/** The parking/gate GSX has resolved the aircraft to, from `state.airport`/`state.parking`/`state.gateProperties`
 *  (docs/gsx-notes.md, round 6): `parking` joins area and gate with a single "|" (`"(N) T1 North|Gate N6"`, not two
 *  fields), and `gateProperties` is free-text amenity tags (`["Gate Heavy", "jetway", "max wingspan 70m", …]`), not a fixed
 *  enum, so they are rendered as plain labels and never matched against a known list. Null until GSX has resolved a gate. */
export interface GsxRemoteGateInfo {
  airportIcao: string
  airportName: string
  parking: string
  gateProperties: string[]
}

/** One of GSX's four static command-bar buttons, taken from the wire payloads and from GSX's own shipped `menu.js`
 *  (unminified, served from the Remote Client's HTTP root). `menu.js` says "the ONLY a-priori knowledge is the four static
 *  command.run ids (which never change)"; `id`/`label` mirror its `STATIC_COMMANDS` array, since the wire carries only icon
 *  images keyed by those ids. **`SETTINGS` is deliberately excluded**: `menu.js`'s click handler never sends a `command.run`
 *  for it, it opens GSX's own in-page settings form (`Settings.open()`, client-side only), which WingLog can't reach
 *  without embedding, the exception Option C existed to avoid. Only the three remotely-triggerable commands are exposed. */
export interface GsxRemoteCommand {
  id: 'CUSTOMIZE_AIRPORT_POSITION' | 'CUSTOMIZE_AIRPLANE' | 'RESTART_COUATL'
  label: string
  /** A data: URI (SVG preferred, PNG fallback — mirrors `menu.js`'s own
   *  `s.commandIconsSvg || s.commandIcons` order) or null if GSX hasn't sent an icon for it. */
  iconUri: string | null
  /** RESTART_COUATL only, per `menu.js`'s own `c.confirm` flag — the real client requires a
   *  second tap within 4s before it actually sends `command.run`, rather than firing on the
   *  first tap. */
  confirm: boolean
}

/** `state.simbrief`: `{status, error, gen}` (docs/gsx-notes.md). Drives the command bar's SimBrief reload button; `gen` is
 *  bumped by GSX once a reload finishes, which is what `menu.js`'s own client uses to clear its optimistic "downloading"
 *  state (mirrored the same way here, not on a timer alone). */
export interface GsxRemoteSimBriefState {
  status: string
  error: string
  gen: number
}

export interface GsxRemoteCommandBar {
  commands: GsxRemoteCommand[]
  simbrief: GsxRemoteSimBriefState | null
  /** RELOAD_SIMBRIEF's own icon — from the same `commandIcons`/`commandIconsSvg` maps as
   *  every `GsxRemoteCommand`, but RELOAD_SIMBRIEF isn't itself a `GsxRemoteCommand` (its
   *  wide-button styling and optimistic busy/loaded/error state are genuinely different from
   *  the three plain command-bar buttons, per `menu.js`'s own separate `simbriefBtn()`). */
  simbriefIconUri: string | null
}

/** Every id `command.run` actually accepts — the three `GsxRemoteCommand` ids plus
 *  RELOAD_SIMBRIEF, which isn't itself a `GsxRemoteCommand` (see `GsxRemoteCommandBar`'s own
 *  doc comment) but runs the exact same way over the wire. */
export type GsxRemoteCommandId = GsxRemoteCommand['id'] | 'RELOAD_SIMBRIEF'

/**
 * GSX's live menu, the control surface. Deliberately generic (GSX's client, menu.js, "reads NO services array, recognizes NO
 * ids/names"): every interactive step, including provider choice when GSX asks, is another snapshot of this shape. The UI
 * renders whatever is in `entries` right now, picked by index.
 *
 * `menuShown` is a *separate* flag from having entries (docs/gsx-notes.md): the menu tree only opens once something sends
 * `menu.toggle` (GSX's own client does this from a permanent header, independent of the in-sim panel, which is how a remote
 * works without the in-sim menu opening). `entries` can be non-empty while `menuShown` is false; GSX's client gates rendering
 * on `menuShown && menu.entries.length`, and so must WingLog's UI.
 *
 * `searchActive`/`searchSession` come from GSX's separate top-level `state.search` key (`{active, session}`, docs/gsx-notes.md
 * round 11), combined in here like `menuShown`. While `searchActive`, the menu is GSX's gate-search list ("Type a gate,
 * terminal or number"): each `menu.search` re-filters `entries` server-side, padded to a fixed page size with empty strings.
 * `searchSession` bumps once per new search.
 */
export interface GsxRemoteMenuState {
  menuShown: boolean
  searchActive: boolean
  searchSession: number
  title: string
  header: string
  subtitle: string
  entries: string[]
  icons: string[]
  disabled: boolean[]
  layout: string
}

/** GSX's free-text modal (Save/Rename Location, etc.) — unrelated to menu/provider choice. */
export interface GsxRemotePromptState {
  kind: 'text'
  gen: number
  title: string
  description: string
  default: string
  maxLength: number
}

/** Result of the one-time, first-ever-launch check for GSX's expected receipts folder (flight-test-findings-2026-09-06.md
 *  #4): `found` means the folder existed and GSX was auto-enabled against it. Returned once, on the launch the check runs;
 *  every later launch gets null from the same IPC call. */
export interface GsxFirstLaunchResult {
  found: boolean
}
