import { BrowserWindow } from 'electron'
import type { DispatchOpenSimBriefParams } from '../../shared/ipc'
import { signSimbriefRequest } from '../backend/backend-client'

const SIMBRIEF_WORKER_URL = 'https://www.simbrief.com/ofp/ofp.loader.api.php'
const SIMBRIEF_HOME_URL = 'https://www.simbrief.com/'

// "persist:" backs this partition with an on-disk store under userData, surviving app
// restarts — Electron's own mechanism, not anything SimBrief-specific (docs/decisions.md,
// flight-test-findings-2026-09-06.md #10). Whether SimBrief's own login cookie is
// actually long-lived enough to still be valid after a restart is a separate question
// this doesn't answer by itself — needs one real login/restart to confirm, tracked in
// decisions.md rather than assumed here. Exported only so a test can assert the prefix
// is actually there, since an accidental revert here would be silent otherwise (nothing
// else would fail — SimBrief would just quietly stop persisting logins again).
export const GENERATE_PARTITION = 'persist:simbrief-generate'

// Only used as a stable, consistent input to the signing request and the submitted
// `outputpage` field — nothing actually needs to be reachable at this address, since
// completion is detected by the popup window closing, not by a browser redirect back to it.
const OUTPUT_PAGE = 'flightdeck.local/generate'

/** The same `type=` value used both for signing and for the actual request — a saved
 *  airframe's internal ID takes priority, then a chosen SimBrief default type, then the
 *  bare ICAO type (docs/simbrief-notes.md: the keyed endpoint has no separate `airframe=`
 *  field, unlike the keyless prefill URL). */
function resolveType(params: DispatchOpenSimBriefParams): string {
  return params.simbriefAirframeId || params.simbriefType || params.icaoType
}

/** Pure query-string assembly, exported for testing — mirrors dispatchOpenSimBrief's
 *  keyless-prefill param set (airline/fltnum/date/deph/depm/extra) plus the three fields
 *  the keyed endpoint additionally needs (apicode/outputpage/timestamp). */
export function buildGenerateUrl(params: DispatchOpenSimBriefParams, apicode: string, timestamp: number): string {
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

function openPopup(url: string): Promise<void> {
  return new Promise((resolve) => {
    const popup = new BrowserWindow({
      width: 600,
      height: 700,
      webPreferences: { partition: GENERATE_PARTITION }
    })
    popup.on('closed', () => resolve())
    popup.loadURL(url)
  })
}

/** Pre-authenticates the generation window's session for the current app run — purely a
 *  convenience, generateOfp handles its own login inline regardless (SimBrief's worker
 *  page itself prompts for login when the session isn't already authenticated). */
export function loginToSimbrief(): Promise<void> {
  return openPopup(SIMBRIEF_HOME_URL)
}

/** Triggers a real SimBrief generation: gets the signing value from flightdeck-backend,
 *  then opens SimBrief's own worker popup, which handles login (if needed), generation
 *  progress, and closes itself once done — resolving this promise. The caller (main/
 *  index.ts) re-fetches via fetchLatestOfp and compares against a pre-generation baseline
 *  to confirm a new plan actually appeared, since this function itself has no way to know
 *  whether the popup closed because generation finished or because the user cancelled. */
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
