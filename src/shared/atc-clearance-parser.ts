import type { ProcedureSelection } from '@shared/ipc'
import { APPROACH_CLEARED, APPROACH_EXPECT, CLEARED_TO, RUNWAY, SID, STAR } from './atc-phrases'

export interface AtcClearanceUpdate {
  fields: Partial<Pick<ProcedureSelection, 'departureRunway' | 'sidIdent' | 'starIdent' | 'approachIdent' | 'approachTransition'>>
  /** A labelled "what changed" summary for the prompt — not BeyondATC's raw sentence. Unlike
   *  GSX's menu text (verbatim third-party content worth preserving as-is), a clearance's
   *  value is which fields it sets, not its exact phrasing. */
  summary: string
  /** A STAR clearance's runway ("cleared LOGA2H arrival, runway 27R"). Not a field:
   *  ProcedureSelection keeps the arrival runway only inside approachIdent (route.ts's
   *  approachRunway), so approachForArrivalRunway (the renderer's atcApproachMatch.ts) turns it into an
   *  approach once the airport's approach list is known. */
  arrivalRunway?: string
}

/** The confirmed real transform (docs/beyondatc-notes.md, "Identifier-matching question
 *  closed", 2026-09-28): the sim's own approach identifiers are space-separated with the
 *  runway baked in ("ILS Z 17R"), where BeyondATC speaks the type hyphenated and states the
 *  runway separately in the same sentence ("ILS-Z" ... "runway 17R"). A deterministic
 *  reassembly, not a fuzzy match — confirmed against one real airport/procedure only. */
export function reformatApproachIdent(type: string, runway: string): string {
  return `${type.replace('-', ' ')} ${runway}`
}

/**
 * Parses one live BeyondATC `ATC:` transcript line into a partial `ProcedureSelection`
 * update, degrading to `null` on anything unrecognised — same discipline as every other
 * external-data parser in this app (route.ts's parseRouteProcedures, the facility-fields
 * parsers): an unparsable clearance never half-applies a guess.
 *
 * Built entirely from real captures, not assumed phrasing (docs/beyondatc-notes.md's "Real
 * SID/STAR/approach clearance samples" and "Identifier-matching question closed" entries,
 * 2026-09-28). BeyondATC's clearances are confirmed template-generated, not freeform.
 */
export function parseAtcClearance(text: string): AtcClearanceUpdate | null {
  // A departure clearance: the SID and runway are each read on their own (atc-phrases.ts), so
  // an unexpected word around one can't lose the other — "via the BIXAD2 departure" once
  // lost both (YBBN, 2026-10-02).
  if (CLEARED_TO.test(text)) {
    const sidIdent = SID.exec(text)?.[1]
    const departureRunway = RUNWAY.exec(text)?.[1]
    if (sidIdent || departureRunway) {
      return {
        fields: { ...(sidIdent && { sidIdent }), ...(departureRunway && { departureRunway }) },
        summary: [sidIdent && `SID ${sidIdent}`, departureRunway && `runway ${departureRunway}`].filter(Boolean).join(', ')
      }
    }
  }

  const star = STAR.exec(text)
  if (star) {
    const [, starIdent] = star
    const runway = RUNWAY.exec(text)?.[1]
    return {
      fields: { starIdent },
      summary: runway ? `STAR ${starIdent}, runway ${runway}` : `STAR ${starIdent}`,
      ...(runway && { arrivalRunway: runway })
    }
  }

  const expect = APPROACH_EXPECT.exec(text)
  if (expect) {
    const [, type, runway, transition] = expect
    const approachIdent = reformatApproachIdent(type!, runway!)
    return {
      fields: transition ? { approachIdent, approachTransition: transition } : { approachIdent },
      summary: transition ? `Approach ${approachIdent} via ${transition}` : `Approach ${approachIdent}`
    }
  }

  const cleared = APPROACH_CLEARED.exec(text)
  if (cleared) {
    const [, type, runway] = cleared
    const approachIdent = reformatApproachIdent(type!, runway!)
    // No transition in this sentence shape — the field is omitted, not nulled, so an
    // earlier-accepted transition (from the "expect..." message) survives.
    return {
      fields: { approachIdent },
      summary: `Approach ${approachIdent}`
    }
  }

  return null
}
