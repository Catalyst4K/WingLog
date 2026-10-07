/** App settings and preferences, first-launch setup, update checks and sync status. */

/** Settings → Tracking (winglog-backend's docs/plans/tracking-auto-toggles.md). Both on by
 *  default; off falls back to the manual Start tracking / Finish & save buttons. */
export interface TrackingSettings {
  /** Start tracking an armed flight once the sim has settled at the departure. */
  autoStart: boolean
  /** Finish the flight once parked with engines off after landing. */
  autoFinish: boolean
}

/** A newer WingLog release found on GitHub (winglog-backend's docs/plans/update-check.md). */
export interface UpdateRelease {
  /** "1.4.1", no "v". */
  version: string
  /** The GitHub release page — validated in main to be on WingLog's own releases. */
  url: string
  /** Release notes, plain text (Markdown source), capped. Never rendered as HTML. */
  notes: string
  publishedAt: string | null
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'upToDate' | 'error'
  currentVersion: string
  latest: UpdateRelease | null
  /** ISO time of the last finished check, successful or not. */
  checkedAt: string | null
  /** "Skip this version": no banner for this one. */
  skippedVersion: string | null
}

/** Settings → About. On by default (Callum, 2026-10-02). */
export interface UpdateSettings {
  checkEnabled: boolean
}

/** First-launch setup (winglog-backend's docs/plans/first-launch-setup.md). */
export interface SetupState {
  /** A new install that hasn't finished or closed the setup yet. */
  show: boolean
  /** An existing user's first launch of a version with the setup: a one-off "what's new". */
  whatsNew: boolean
}

export interface SetupContext {
  gsxFolderFound: boolean
  gsxFolderPath: string | null
  /** BeyondATC answering on this PC right now. Shown, never acted on by itself. */
  beyondAtcRunning: boolean
}

/**
 * Display unit for weights app-wide (Fleet and Dispatch both). Storage stays SI (kg)
 * regardless — see §5 — this only controls what the UI shows/accepts. Defaults to 'lb'
 * if never set.
 */
export type WeightUnit = 'kg' | 'lb'

/**
 * Settings' UI page theme (docs/plans/settings-ui-page.md) — 'system' resolves via
 * `window.matchMedia('(prefers-color-scheme: dark)')` and keeps listening, so a user on
 * 'system' sees the app follow an OS appearance change made while it's open. Defaults to
 * 'system' if never set.
 */
export type Theme = 'light' | 'dark' | 'system'

/**
 * Display unit for OFP-derived altitudes (Dispatch's cruise altitude and step climbs).
 * A step climb point is sometimes a metric flight level rather than a standard one (e.g.
 * crossing Chinese airspace) — see parseStepClimbs in simbrief-client.ts for how that's
 * detected and converted to a real feet value. 'ft'/'m' both show every point converted
 * to that one unit; 'hybrid' shows each point in whichever unit it was actually coded
 * in (its `native` field) — feet for a standard level, metres for a metric one — which
 * is how a route crossing into e.g. Chinese airspace actually reads on the OFP itself.
 * Defaults to 'ft' if never set.
 */
export type AltitudeUnit = 'ft' | 'm' | 'hybrid'

/** Display unit for METAR wind speed. Most stations report in knots, but ICAO METARs
 *  outside North America commonly use an `MPS` wind group instead — 'kt' is the default
 *  since knots is the unit most of this app already assumes elsewhere. The raw METAR text
 *  is always shown verbatim regardless of this setting; it only controls a separately
 *  formatted wind line alongside it. */
export type WindSpeedUnit = 'kt' | 'mps'

/** Language of the base map's place names (winglog-backend docs/plans/
 *  map-language-and-declutter.md). 'local' is each place's own native name. */
export type MapLanguage = 'local' | 'en' | 'de' | 'es' | 'fr' | 'it' | 'ru'

/**
 * The app's own UI display language (winglog-backend docs/plans/v1-2.md Part 3,
 * decisions.md 2026-09-20) — distinct from MapLanguage above, which only ever affects map
 * place names. 'system' (the default) resolves to the OS's own locale client-side
 * (app-language.ts's resolveAppLanguage), falling back to English when no catalogue exists
 * yet for it; the rest are an explicit override, persisted once chosen. Real aviation terms
 * of art (ILS, STAR, SID, FL, QNH, ICAO idents) and anything sourced from SimBrief (which
 * has no documented language support of its own) stay in English regardless of this
 * setting. Covers both the renderer and main-process strings (native dialog titles, the
 * startup error box's title) — see src/main/i18n.ts.
 *
 * `zh-CN`/`zh-TW` are two separate catalogues, not one 'zh' with a region: Simplified and
 * Traditional Chinese are different written forms (and Traditional's own real-world
 * terminology differs further by region — Taiwan vs. Hong Kong — `zh-TW` covers Taiwan
 * only for now, see app-language.ts). Electron's `app.getLocale()` is documented to return
 * exactly these codes for Chinese locales (electronjs.org/docs/latest/api/app#appgetlocale,
 * "Some examples of returned values are en-US, zh-CN") — not independently confirmed live
 * against a real Chinese-locale Windows install from this repo.
 */
export type AppLanguage = 'system' | 'en' | 'de' | 'es' | 'fr' | 'it' | 'ru' | 'zh-CN' | 'zh-TW'

/**
 * Display unit for Logbook's two runway-relative landing measurements (distance from
 * threshold, centreline offset) and the touchdown diagram's labels — docs/plans/
 * logbook-detail-improvements.md, item 4. Defaults to 'ft' (Callum's call), unlike most of
 * this app's other unit settings — landing distances read most naturally in feet even for
 * pilots who otherwise think in metric. Deliberately scoped to just these two fields:
 * touchdown rate stays fpm and speeds/wind stay kt regardless of this setting.
 */
export type LandingDistanceUnit = 'ft' | 'm'

/** The app's tabs — also the native menu bar's top-level items, see main/menu.ts. */
export type AppPage = 'fleet' | 'dispatch' | 'track' | 'gsx' | 'beyondatc' | 'logbook' | 'settings'

/** Cloud sync's runtime status (winglog-backend/docs/plans/cloud-sync.md) — polled by
 *  Settings' "Cloud sync" section rather than pushed, since a sync is infrequent and
 *  short (launch + manual "Sync now"), not worth a dedicated push channel for. */
export interface SyncStatus {
  loggedIn: boolean
  email: string | null
  syncing: boolean
  /** ISO 8601 UTC of the last sync that completed without throwing — individual tables
   *  can still have skipped/rejected rows even when this is set; see lastError for
   *  whether the run itself failed outright. */
  lastSyncedAt: string | null
  lastError: string | null
}
