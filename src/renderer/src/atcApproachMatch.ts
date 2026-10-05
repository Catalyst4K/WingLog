import type { NavdataProcedureOption, ProcedureSelection } from '@shared/ipc'
import type { AtcClearanceUpdate } from '@shared/atc-clearance-parser'
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
