/**
 * Dispatch IPC: fetching and generating the SimBrief OFP, the SimBrief login, and the SimBrief
 * pages and OFP PDF opened outside the app. Every channel is a query (coding-standards.md §9):
 * plain IPC to the local database, SimBrief or the backend.
 */
import { shell, type IpcMain } from 'electron'
import { IpcChannels, type DispatchOfp, type DispatchOpenSimBriefParams } from '@shared/ipc'
import { t } from '../i18n'
import type { WingLogDb } from '../db/client'
import { getAircraftByRegistration } from '../db/aircraft-repo'
import { getInProgressFlight } from '../db/flight-repo'
import { getSimbriefUsername } from '../db/settings-repo'
import { extractOfpPdfUrl } from '../simbrief/ofp-pdf'
import { fetchLatestOfp, parseOfp, type SimBriefOfp } from '../simbrief/simbrief-client'
import {
  fetchSimbriefUsername,
  generateOfp,
  isSimbriefLoggedIn,
  loginToSimbrief,
  logoutOfSimbrief
} from '../simbrief/simbrief-generate'

const SIMBRIEF_DISPATCH = 'https://dispatch.simbrief.com'

/**
 * The SimBrief planning page, prefilled with the flight. Falls back to SimBrief's home page when
 * there's no origin, destination or aircraft to prefill.
 *
 * @param params The flight, from Dispatch.
 * @returns An https URL on dispatch.simbrief.com, every value encoded.
 */
export function simbriefPrefillUrl(params: DispatchOpenSimBriefParams): string {
  const {
    origIcao,
    destIcao,
    icaoType,
    simbriefAirframeId,
    simbriefType,
    airlineIcao,
    flightNumber,
    departure,
    extra
  } = params
  if (!origIcao || !destIcao || (!icaoType && !simbriefAirframeId)) return `${SIMBRIEF_DISPATCH}/`
  // `airframe=` takes priority when a saved SimBrief profile exists; otherwise `type=`
  // lets SimBrief fall back to its own default airframe for that type ICAO — SimBrief's
  // own behavior, nothing WingLog implements itself (docs/decisions.md). A chosen
  // simbriefType (a specific SimBrief default, e.g. "A20N" rather than the bare
  // icaoType "A320") takes priority over icaoType within that fallback.
  const airframeParam = simbriefAirframeId
    ? `airframe=${encodeURIComponent(simbriefAirframeId)}`
    : `type=${encodeURIComponent(simbriefType || icaoType)}`
  let url =
    `${SIMBRIEF_DISPATCH}/options/custom?orig=${encodeURIComponent(origIcao)}` +
    `&dest=${encodeURIComponent(destIcao)}&${airframeParam}`
  // Optional generation prefills (docs/decisions.md, SimBrief-generation entry) — each
  // only appended when present, so leaving them unset reproduces the URL above exactly.
  // Verified live 2026-09-02 (docs/simbrief-notes.md) that the keyless prefill form
  // honours all of these, including `date` taking epoch seconds rather than a date
  // string — `departure` arrives pre-converted from src/renderer/src/dispatch-time.ts,
  // never computed here from free text.
  if (airlineIcao) url += `&airline=${encodeURIComponent(airlineIcao)}`
  if (flightNumber) url += `&fltnum=${encodeURIComponent(flightNumber)}`
  if (departure) {
    url += `&date=${departure.dateEpochSeconds}&deph=${departure.hour}&depm=${departure.minute}`
  }
  // Advanced options (pax/fuel/cruise/route) from src/shared/dispatch-options.ts — already reduced
  // to only the fields the user actually set, so an untouched advanced dialog appends
  // nothing here (docs/decisions.md, dispatch-advanced-tab entry).
  for (const [key, value] of extra ?? []) {
    url += `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  }
  return url
}

/**
 * The SimBrief editor for one saved airframe, or the list of them.
 *
 * The internal ID is `<simbrief user id>_<airframe id>`, and the per-airframe editor takes just
 * the suffix (docs/simbrief-notes.md, "Saved airframes" — confirmed live against a real
 * airframe). Treated as an opaque string, never parsed as a date, even though it happens to look
 * like a millisecond epoch — an older ID format uses a 10-digit seconds value instead, and the
 * rule is "take the suffix verbatim" either way.
 *
 * @param airframeId WingLog's stored SimBrief airframe ID, or null.
 * @returns The airframe's page, or the list page for a malformed or absent ID.
 */
export function simbriefAirframeUrl(airframeId: string | null): string {
  const suffix = airframeId?.split('_')[1]
  return suffix
    ? `${SIMBRIEF_DISPATCH}/airframes/saved/${encodeURIComponent(suffix)}`
    : `${SIMBRIEF_DISPATCH}/airframes`
}

/**
 * Registers the Dispatch channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database.
 */
export function registerDispatchHandlers(ipcMain: IpcMain, { db }: { db: WingLogDb }): void {
  const mapOfpForIpc = (ofp: SimBriefOfp): DispatchOfp => {
    const matched = getAircraftByRegistration(db, ofp.aircraftRegistration)
    const { rawJson, ...rest } = ofp
    return { ...rest, ofpJson: rawJson, matchedAircraftId: matched?.id ?? null }
  }
  const requireUsername = (): string => {
    const username = getSimbriefUsername(db)
    if (!username) throw new Error(t('errors.setSimbriefUsernameFirst'))
    return username
  }

  ipcMain.handle(IpcChannels.dispatchFetchOfp, async (): Promise<DispatchOfp> => {
    return mapOfpForIpc(await fetchLatestOfp(requireUsername()))
  })

  ipcMain.handle(IpcChannels.dispatchGetInProgressFlight, () => {
    const inProgress = getInProgressFlight(db)
    if (!inProgress?.ofpJson) return null
    try {
      return { flight: inProgress, ofp: mapOfpForIpc(parseOfp(JSON.parse(inProgress.ofpJson))) }
    } catch {
      // A malformed/unexpected stored ofpJson must degrade to "nothing to restore",
      // not break Dispatch on every future launch — external data, parsed defensively.
      return null
    }
  })

  ipcMain.handle(IpcChannels.dispatchGenerateOfp, async (_event, params: DispatchOpenSimBriefParams) => {
    const username = requireUsername()
    // Baseline for the "did a new plan actually appear" check below — best-effort, a
    // pilot with no prior OFP at all is a valid starting state, not an error.
    const baselineOfpId = await fetchLatestOfp(username)
      .then((ofp) => ofp.ofpId)
      .catch(() => null)
    await generateOfp(params)
    const ofp = await fetchLatestOfp(username)
    if (ofp.ofpId === baselineOfpId) throw new Error(t('errors.noNewPlanGenerated'))
    return mapOfpForIpc(ofp)
  })

  ipcMain.handle(IpcChannels.dispatchLoginSimbrief, () => loginToSimbrief())
  ipcMain.handle(IpcChannels.dispatchSimbriefLoginStatus, () => isSimbriefLoggedIn())
  ipcMain.handle(IpcChannels.dispatchLogoutSimbrief, () => logoutOfSimbrief())
  ipcMain.handle(IpcChannels.dispatchFetchSimbriefUsername, () => fetchSimbriefUsername())

  ipcMain.handle(IpcChannels.dispatchOpenSimBrief, (_event, params: DispatchOpenSimBriefParams) =>
    shell.openExternal(simbriefPrefillUrl(params))
  )
  ipcMain.handle(IpcChannels.dispatchOpenSimBriefAirframes, (_event, airframeId: string | null) =>
    shell.openExternal(simbriefAirframeUrl(airframeId))
  )

  // Sibling of logbookOpenOfpPdf (docs/plans/dispatch-action-buttons.md) — a
  // fetched-but-not-yet-flown Dispatch plan has no flight row to look the OFP JSON up by
  // id, but the renderer already holds it (DispatchOfp.ofpJson), so it's passed straight
  // through instead. extractOfpPdfUrl already treats its input as untrusted third-party
  // JSON and validates the resulting URL (https: and www.simbrief.com only) before it ever
  // reaches shell.openExternal — unchanged, must stay that way.
  ipcMain.handle(IpcChannels.dispatchOpenOfpPdf, async (_event, ofpJson: string) => {
    const url = extractOfpPdfUrl(ofpJson)
    if (!url) return false
    await shell.openExternal(url)
    return true
  })

  // Always true now — generation goes through winglog-backend rather than a per-build
  // key, so there's no "build with no key baked in" case to fall back from anymore. Kept
  // as a channel (rather than removing it and the renderer's "Plan on SimBrief…" fallback
  // entirely) in case a future bring-your-own-key or backend-downtime path wants it back.
  ipcMain.handle(IpcChannels.dispatchGenerationAvailable, () => true)
}
