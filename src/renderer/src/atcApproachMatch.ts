import type { NavdataProcedureOption } from '@shared/ipc'
import type { AtcClearanceUpdate } from './atcClearanceParser'

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
