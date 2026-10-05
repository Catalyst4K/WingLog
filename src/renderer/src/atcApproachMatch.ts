import type { NavdataProcedureOption, ProcedureSelection } from '@shared/ipc'
import type { AtcClearanceUpdate } from './atcClearanceParser'
import { approachRunway, pickDefaultApproachIdentifier } from './route'

/** "R NAV 02L", "RNAV 02L", "rnav-02l" all compare equal: what ATC says and what the sim
 *  calls a procedure differ only in spacing, hyphens and case. */
function compact(ident: string): string {
  return ident.toUpperCase().replace(/[\s-]/g, '')
}

/**
 * Swaps a clearance's spoken approach name for the arrival airport's real one, so accepting
 * it selects something that exists (WSSS, 2026-10-02: BeyondATC's "R-NAV approach runway 02L
 * with the SANAT transition" became "R NAV 02L", which matched nothing, so Update did nothing;
 * the sim calls it "RNAV 02L"). The transition is checked against that approach's own
 * transitions the same way.
 *
 * With no approach list to check against (the airport's navdata not fetched yet), the update
 * is returned unchanged. With a list and no match, the approach fields are dropped rather than
 * applied as a name nothing will show; the rest of the update still goes through.
 */
export function matchClearanceApproach(
  update: AtcClearanceUpdate,
  options: NavdataProcedureOption[]
): AtcClearanceUpdate | null {
  const spoken = update.fields.approachIdent
  if (!spoken || options.length === 0) return update

  const rest = { ...update.fields }
  delete rest.approachIdent
  delete rest.approachTransition
  const identifier = options.find((o) => compact(o.identifier) === compact(spoken))?.identifier
  if (!identifier) return Object.keys(rest).length > 0 ? { ...update, fields: rest } : null

  const fields: AtcClearanceUpdate['fields'] = { ...rest, approachIdent: identifier }
  const spokenTransition = update.fields.approachTransition
  if (spokenTransition) {
    const transition = options.find(
      (o) => o.identifier === identifier && o.transition && compact(o.transition) === compact(spokenTransition)
    )?.transition
    if (transition) fields.approachTransition = transition
  }
  const summary = fields.approachTransition ? `Approach ${identifier} via ${fields.approachTransition}` : `Approach ${identifier}`
  return { fields, summary }
}

/**
 * Turns a STAR clearance's runway into the approach to fly when it isn't the runway the
 * selected approach is for. EGLL, 2026-10-05: ATC cleared "LOGA2H arrival, runway 27R"
 * against SimBrief's 27L, with no approach named, so ILS 27L stayed selected and nothing
 * prompted. The approach is the same default ProcedureSelector picks for a planned runway
 * (ILS, then LOC, then the first other). The current transition is kept when the new
 * approach has it (LAM, where LOGA2H ends), otherwise left empty for ProcedureSelector to
 * connect to wherever the STAR ends.
 *
 * Returns the update unchanged when it names no runway, the selected approach is already
 * for that runway, or there's no approach list or no approach for that runway to choose.
 */
export function approachForArrivalRunway(
  update: AtcClearanceUpdate,
  options: NavdataProcedureOption[],
  current: Pick<ProcedureSelection, 'approachIdent' | 'approachTransition'>
): AtcClearanceUpdate {
  const runway = update.arrivalRunway
  if (!runway || approachRunway(current.approachIdent) === runway) return update
  const approachIdent = pickDefaultApproachIdentifier(options.filter((o) => approachRunway(o.identifier) === runway))
  if (!approachIdent) return update
  const keepsTransition = options.some(
    (o) => o.identifier === approachIdent && o.transition !== null && o.transition === current.approachTransition
  )
  const approachTransition = keepsTransition ? current.approachTransition : null
  return {
    ...update,
    fields: { ...update.fields, approachIdent, approachTransition },
    summary: `${update.summary}: ${approachIdent}${approachTransition ? ` via ${approachTransition}` : ''}`
  }
}
