import type { NavdataProcedureOption, ProcedureSelection } from '@shared/ipc'
import type { AtcClearanceUpdate } from '@shared/atc-info-boxes'
import { approachRunway, pickDefaultApproachIdentifier } from './route'

/**
 * Turns a STAR clearance's runway into the approach to fly when it isn't the runway the
 * selected approach is for. EGLL, 2026-10-05: ATC cleared "LOGA2H arrival, runway 27R"
 * against SimBrief's 27L, with no approach named, so ILS 27L stayed selected and nothing
 * prompted. The approach is the same default ProcedureSelector picks for a planned runway
 * (ILS, then LOC, then the first other). The current transition is kept when the new
 * approach has it (LAM, where LOGA2H ends), otherwise left empty for ProcedureSelector to
 * connect to wherever the STAR ends.
 *
 * `starEndFix` is the cleared STAR's last fix. When given, the approach must connect to it:
 * an approach that has a transition starting there is preferred, and that transition is
 * selected. ZJSY, 2026-10-05: "cleared UPRS2C arrival, runway 08" with ILS X 08 already
 * selected, but UPRS2C ends at SY498, which only ILS Z 08 starts from.
 *
 * Returns the update unchanged when it names no runway, or there's no approach list or no
 * approach for that runway to choose. It's also unchanged when the selected approach is
 * already for that runway, unless it doesn't connect to the STAR and another one there does.
 */
export function approachForArrivalRunway(
  update: AtcClearanceUpdate,
  options: NavdataProcedureOption[],
  current: Pick<ProcedureSelection, 'approachIdent' | 'approachTransition'>,
  starEndFix: string | null = null
): AtcClearanceUpdate {
  const runway = update.arrivalRunway
  if (!runway) return update
  const forRunway = options.filter((o) => approachRunway(o.identifier) === runway)
  const hasTransition = (identifier: string | null, transition: string | null): boolean =>
    transition !== null && forRunway.some((o) => o.identifier === identifier && o.transition === transition)
  if (approachRunway(current.approachIdent) === runway) {
    const connectsElsewhere = starEndFix !== null && forRunway.some((o) => o.transition === starEndFix)
    if (!connectsElsewhere || hasTransition(current.approachIdent, starEndFix)) return update
  }
  const approachIdent = pickDefaultApproachIdentifier(forRunway, starEndFix)
  if (!approachIdent) return update
  const approachTransition = hasTransition(approachIdent, starEndFix)
    ? starEndFix
    : hasTransition(approachIdent, current.approachTransition)
      ? current.approachTransition
      : null
  return {
    ...update,
    fields: { ...update.fields, approachIdent, approachTransition },
    summary: `${update.summary}: ${approachIdent}${approachTransition ? ` via ${approachTransition}` : ''}`
  }
}

/**
 * The last named fix of a STAR clearance's procedure, for `approachForArrivalRunway`. Null
 * when the clearance names no STAR, or the airport's navdata doesn't have it or can't be read.
 */
export async function starEndFix(icao: string, update: AtcClearanceUpdate): Promise<string | null> {
  const star = update.fields.starIdent
  if (!star) return null
  const legs = await window.winglog
    .navdataGetProcedureWaypoints(icao, 'star', star, update.arrivalRunway ?? null)
    .catch(() => [])
  return [...legs].reverse().find((leg) => leg.fixIdent)?.fixIdent ?? null
}
