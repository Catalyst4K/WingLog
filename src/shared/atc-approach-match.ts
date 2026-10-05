import type { NavdataProcedureOption } from './ipc'
import type { AtcClearanceUpdate } from './atc-info-boxes'

/** "R NAV 02L", "RNAV 02L", "rnav-02l" all compare equal: what BeyondATC calls a procedure and
 *  what the sim calls it differ only in spacing, hyphens and case. */
function compact(ident: string): string {
  return ident.toUpperCase().replace(/[\s-]/g, '')
}

/**
 * Swaps BeyondATC's approach name (the `Cleared Approach` box) for the arrival airport's real
 * one, so accepting it selects something that exists (WSSS, 2026-10-02: BeyondATC's "R-NAV
 * approach runway 02L" became "R NAV 02L", which matched nothing, so Update did nothing; the
 * sim calls it "RNAV 02L"). The transition is checked against that approach's own
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
  const cleared = update.fields.approachIdent
  if (!cleared || options.length === 0) return update

  const rest = { ...update.fields }
  delete rest.approachIdent
  delete rest.approachTransition
  const identifier = options.find((o) => compact(o.identifier) === compact(cleared))?.identifier
  if (!identifier) return Object.keys(rest).length > 0 ? { ...update, fields: rest } : null

  const fields: AtcClearanceUpdate['fields'] = { ...rest, approachIdent: identifier }
  const clearedTransition = update.fields.approachTransition
  if (clearedTransition) {
    const transition = options.find(
      (o) => o.identifier === identifier && o.transition && compact(o.transition) === compact(clearedTransition)
    )?.transition
    if (transition) fields.approachTransition = transition
  }
  const summary = fields.approachTransition ? `Approach ${identifier} via ${fields.approachTransition}` : `Approach ${identifier}`
  return { fields, summary }
}
