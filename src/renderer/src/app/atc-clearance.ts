/**
 * Turns a clearance read from BeyondATC's InfoBoxes into one worth offering: names its approach
 * the way the sim does, and drops it when it matches what's already selected.
 */

import { winglogApi } from '../data/winglog-api'
import type { ProcedureSelection } from '@shared/ipc'
import { matchClearanceApproach } from '@shared/atc-approach-match'
import type { AtcClearanceUpdate } from '@shared/atc-info-boxes'
import { approachForArrivalRunway, starEndFix } from '../atc-approach-match'

/** A clearance waiting for the user's accept or dismiss, with when BeyondATC gave it. */
export type PendingAtcClearance = AtcClearanceUpdate & { sourceTs: number }

/**
 * Whether any of the clearance's fields differ from the current selection.
 *
 * @param update The clearance.
 * @param selection The current procedure selection.
 * @returns True when accepting it would change something.
 */
export function clearanceDiffers(update: AtcClearanceUpdate, selection: ProcedureSelection): boolean {
  return Object.entries(update.fields).some(
    ([key, value]) => selection[key as keyof ProcedureSelection] !== value
  )
}

/**
 * BeyondATC names approaches its own way ("R-NAV approach runway 02L"); swap in the arrival
 * airport's own name so accepting it selects something real (WSSS, 2026-10-02). The airport is
 * the one being flown to: the selected arrival, else BeyondATC's own route.
 * A STAR clearance's runway picks the approach for it when it isn't the selected approach's
 * runway (EGLL, 2026-10-05: LOGA2H, runway 27R against a planned ILS 27L), or when the selected
 * one doesn't start where the STAR ends (ZJSY, 2026-10-05: UPRS2C ends at SY498, the entry to
 * ILS Z 08, not ILS X 08).
 *
 * @param update The clearance as parsed.
 * @param selection The current procedure selection.
 * @returns The clearance with the sim's own approach, null when no approach matches, or the
 *   clearance unchanged when there's no approach list to check against.
 */
async function withSimApproach(
  update: AtcClearanceUpdate,
  selection: ProcedureSelection
): Promise<AtcClearanceUpdate | null> {
  try {
    const icao = selection.arrivalIcao ?? (await winglogApi().beyondAtcGetState()).progress?.to ?? null
    if (!icao) return update
    const approaches = await winglogApi().navdataListApproaches(icao, null)
    // The approach must start where the STAR ends, or at the transition ATC briefed.
    const entryFix = update.fields.approachTransition ?? (await starEndFix(icao, update))
    return update.fields.approachIdent
      ? matchClearanceApproach(update, approaches)
      : approachForArrivalRunway(update, approaches, selection, entryFix)
  } catch {
    // No list to check against: offer the clearance as parsed.
    return update
  }
}

/**
 * The clearance to offer the user, if any.
 *
 * @param candidate The clearance read from a new set of InfoBoxes.
 * @param selection The current procedure selection.
 * @returns The clearance to offer, or null when there's nothing new in it.
 */
export async function resolveAtcClearance(
  candidate: PendingAtcClearance,
  selection: ProcedureSelection
): Promise<PendingAtcClearance | null> {
  const needsApproach = Boolean(candidate.fields.approachIdent || candidate.arrivalRunway)
  const update = needsApproach ? await withSimApproach(candidate, selection) : candidate
  if (!update || !clearanceDiffers(update, selection)) return null
  return { ...update, sourceTs: candidate.sourceTs }
}
