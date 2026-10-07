/**
 * Generating a SimBrief OFP from Dispatch, and the SimBrief login it needs: a SimBrief window in its
 * own persistent session, the authorization value from winglog-backend, and reading the account's
 * username and pilot id from SimBrief's own pages.
 */
import { runLogged } from '../logging/run-logged'
import { BrowserWindow, session } from 'electron'
import type { DispatchOpenSimBriefParams } from '../../shared/ipc'
import { signSimbriefRequest } from '../backend/backend-client'

const SIMBRIEF_WORKER_URL = 'https://www.simbrief.com/ofp/ofp.loader.api.php'
const SIMBRIEF_HOME_URL = 'https://www.simbrief.com/'

// "persist:" backs this partition with an on-disk store under userData, surviving app restarts (Electron's mechanism, not
// SimBrief-specific; docs/decisions.md, flight-test-findings-2026-09-06.md #10). Whether SimBrief's own login cookie lives
// long enough to still be valid after a restart is a separate question, tracked in decisions.md. Exported only so a test
// can assert the prefix is there: an accidental revert would be silent (SimBrief would just stop persisting logins).
export const GENERATE_PARTITION = 'persist:simbrief-generate'

// Only used as a stable, consistent input to the signing request and the submitted
// `outputpage` field — nothing actually needs to be reachable at this address, since
// completion is detected by the popup window closing, not by a browser redirect back to it.
const OUTPUT_PAGE = 'winglog.local/generate'

/** The same `type=` value used both for signing and for the actual request — a saved
 *  airframe's internal ID takes priority, then a chosen SimBrief default type, then the
 *  bare ICAO type (docs/simbrief-notes.md: the keyed endpoint has no separate `airframe=`
 *  field, unlike the keyless prefill URL).
 *
 * @param params The flight from Dispatch.
 * @returns The `type=` value.
 */
function resolveType(params: DispatchOpenSimBriefParams): string {
  return params.simbriefAirframeId || params.simbriefType || params.icaoType
}

/** Pure query-string assembly, exported for testing — mirrors dispatchOpenSimBrief's
 *  keyless-prefill param set (airline/fltnum/date/deph/depm/extra) plus the three fields
 *  the keyed endpoint additionally needs (apicode/outputpage/timestamp).
 *
 * @param params The flight from Dispatch.
 * @param apicode The authorization value from winglog-backend.
 * @param timestamp The same Unix time, in seconds, the authorization was made for.
 * @returns The generation URL.
 */
export function buildGenerateUrl(
  params: DispatchOpenSimBriefParams,
  apicode: string,
  timestamp: number
): string {
  const query = new URLSearchParams({
    orig: params.origIcao,
    dest: params.destIcao,
    type: resolveType(params),
    apicode,
    outputpage: OUTPUT_PAGE,
    timestamp: String(timestamp)
  })
  if (params.airlineIcao) query.set('airline', params.airlineIcao)
  if (params.flightNumber) query.set('fltnum', params.flightNumber)
  if (params.departure) {
    query.set('date', String(params.departure.dateEpochSeconds))
    query.set('deph', String(params.departure.hour))
    query.set('depm', String(params.departure.minute))
  }
  for (const [key, value] of params.extra ?? []) {
    query.set(key, value)
  }
  return `${SIMBRIEF_WORKER_URL}?${query.toString()}`
}

/**
 * Opens a SimBrief window in the persistent SimBrief session.
 *
 * @param url The SimBrief page to open.
 * @returns Settles when the pilot or the page closes the window.
 */
function openPopup(url: string): Promise<void> {
  return new Promise((resolve) => {
    const popup = new BrowserWindow({
      width: 600,
      height: 700,
      webPreferences: { partition: GENERATE_PARTITION }
    })
    popup.on('closed', () => resolve())
    runLogged('simbrief: open window', popup.loadURL(url))
  })
}

/** Pre-authenticates the generation window's session, persisted across restarts since GENERATE_PARTITION carries the
 *  `persist:` prefix (docs/decisions.md's SimBrief-login-persistence entry). generateOfp handles its own login inline
 *  regardless (SimBrief's worker page prompts for login when the session isn't authenticated); this is only for showing
 *  status without requiring the user to open Dispatch first.
 *
 * @returns Settles when the window closes.
 */
export function loginToSimbrief(): Promise<void> {
  return openPopup(SIMBRIEF_HOME_URL)
}

const SIMBRIEF_SSO_COOKIE_NAME = 'simbrief_sso'
const SIMBRIEF_COOKIE_DOMAIN = 'simbrief.com'

/**
 * Whether the persisted generation-popup session is still logged into SimBrief right now, not just whether the partition
 * has ever been used. Checked via simbrief_sso's presence, the cookie SimBrief sets on login (docs/simbrief-notes.md's
 * login-status entry). Google Analytics/Ads cookies (`_ga`, `_gid`, `_gcl_au`, ...) are present in this partition
 * regardless of login state, so checking for *any* cookie wouldn't distinguish the two.
 *
 * @returns True when SimBrief's sign-in cookie is present.
 */
export async function isSimbriefLoggedIn(): Promise<boolean> {
  const cookies = await session
    .fromPartition(GENERATE_PARTITION)
    .cookies.get({ name: SIMBRIEF_SSO_COOKIE_NAME, domain: SIMBRIEF_COOKIE_DOMAIN })
  return cookies.length > 0
}

/** Logs out of the persisted generation session — clears everything stored in
 *  GENERATE_PARTITION (cookies included), not just the SSO cookie, since this partition
 *  exists solely for SimBrief's login/generation popup and holds nothing else worth
 *  keeping. */
export async function logoutOfSimbrief(): Promise<void> {
  await session.fromPartition(GENERATE_PARTITION).clearStorageData()
}

const ACCOUNT_PAGE_URL = 'https://www.simbrief.com/system/profile.php'
const ACCOUNT_PAGE_TIMEOUT_MS = 5000

/** Reads one field off SimBrief's account-settings page: its "Your SimBrief Data" section renders every field's value via a
 *  JS-populated `<input data-key="...">` after load (the shipped HTML has `value=""`; docs/simbrief-notes.md). Shared by
 *  fetchSimbriefUsername and fetchSimbriefPilotId. Returns `null` on anything unexpected (not logged in, page layout
 *  changed, timed out) rather than throwing: this is third-party page content, parsed defensively like any other external
 *  data, and a markup change must not take down a caller.
 *
 * @param dataKey The field's `data-key`, e.g. user.pilot_id.
 * @returns The value, or null.
 */
async function readAccountField(dataKey: string): Promise<string | null> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition: GENERATE_PARTITION }
  })
  try {
    await win.loadURL(ACCOUNT_PAGE_URL)
    const value = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const start = Date.now()
        const check = () => {
          const el = document.querySelector('input[data-key="${dataKey}"]')
          if (el && el.value) return resolve(el.value)
          if (Date.now() - start > ${ACCOUNT_PAGE_TIMEOUT_MS}) return resolve(null)
          setTimeout(check, 200)
        }
        check()
      })
    `)
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  } finally {
    win.destroy()
  }
}

/** `data-key="user.navigraph.username"` is the same value SimBrief's own UI labels
 *  "Username" in the "Your SimBrief Data" section — Navigraph's acquisition unified the
 *  two, so this is the account's one real username, not something SimBrief-specific under
 *  the hood. Only meaningful to call once `isSimbriefLoggedIn()` is true. Used by Settings
 *  to offer to fill the username field automatically instead of requiring it be typed in.
 *
 * @returns The username, or null.
 */
export function fetchSimbriefUsername(): Promise<string | null> {
  return readAccountField('user.navigraph.username')
}

/** `data-key="user.pilot_id"`: the numeric half of a saved airframe's internal id (`<pilot_id>_<airframe_id>`,
 *  docs/decisions.md §4) that a share link's URL doesn't reveal (docs/plans/simbrief-airframe-picker.md). The same page and
 *  field-read pattern as the username above, just another field in the "Your SimBrief Data" section.
 *
 * @returns The pilot id, or null.
 */
export function fetchSimbriefPilotId(): Promise<string | null> {
  return readAccountField('user.pilot_id')
}

/** Triggers a real SimBrief generation: gets the signing value from winglog-backend,
 *  then opens SimBrief's own worker popup, which handles login (if needed), generation
 *  progress, and closes itself once done — resolving this promise. The caller (main/
 *  index.ts) re-fetches via fetchLatestOfp and compares against a pre-generation baseline
 *  to confirm a new plan actually appeared, since this function itself has no way to know
 *  whether the popup closed because generation finished or because the user cancelled.
 *
 * @param params The flight from Dispatch.
 * @throws When winglog-backend won't authorize the request.
 */
export async function generateOfp(params: DispatchOpenSimBriefParams): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000)
  const apicode = await signSimbriefRequest({
    origIcao: params.origIcao,
    destIcao: params.destIcao,
    type: resolveType(params),
    timestamp,
    outputPage: OUTPUT_PAGE
  })
  await openPopup(buildGenerateUrl(params, apicode, timestamp))
}

// Matches the URL SimBrief's client-side router redirects to right after a save (docs/plans/simbrief-airframe-picker.md):
// only the airframe_id half, never the pilot_id, hence fetchSimbriefPilotId above.
const SAVED_AIRFRAME_PATTERN = /\/airframes\/saved\/(\d+)/

/** Pure URL-matching, exported for testing — the part of createCustomAirframeFromShare
 *  that doesn't need a real BrowserWindow to exercise. Null for any URL that isn't the
 *  post-save redirect (every other navigation the share/login flow passes through).
 *
 * @param url A URL the window navigated to.
 * @returns The saved airframe's id, or null.
 */
export function extractSavedAirframeId(url: string): string | null {
  return url.match(SAVED_AIRFRAME_PATTERN)?.[1] ?? null
}

/**
 * Opens a visible SimBrief airframe share link and waits for the pilot to review it and click **Save Airframe** in their own
 * session. This is a sanctioned cross-user mechanism (SimBrief's "Share Airframe" help text), not something that only
 * resolves for the link's original owner. Resolves with the resulting `<pilot_id>_<airframe_id>` once the save's navigation
 * is observed, or `null` if the window was closed first (the pilot backed out, or never finished logging in): a
 * cancellation, not an error.
 *
 * @param shareUrl A SimBrief airframe share link.
 * @returns `<pilot_id>_<airframe_id>`, or null if the pilot closed the window first.
 */
export function createCustomAirframeFromShare(shareUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 900,
      height: 800,
      webPreferences: { partition: GENERATE_PARTITION }
    })
    let settled = false

    async function onNavigate(url: string): Promise<void> {
      if (settled) return
      const airframeId = extractSavedAirframeId(url)
      if (!airframeId) return
      settled = true
      // Same persisted partition the pilot just logged into (if they needed to) —
      // already-authenticated, no separate login step of its own.
      const pilotId = await fetchSimbriefPilotId()
      win.close()
      resolve(pilotId ? `${pilotId}_${airframeId}` : null)
    }

    win.webContents.on('did-navigate', (_event, url) => runLogged('simbrief: pilot id', onNavigate(url)))
    win.webContents.on('did-navigate-in-page', (_event, url) =>
      runLogged('simbrief: pilot id', onNavigate(url))
    )
    win.on('closed', () => {
      if (!settled) {
        settled = true
        resolve(null)
      }
    })

    runLogged('simbrief: open share page', win.loadURL(shareUrl))
  })
}
