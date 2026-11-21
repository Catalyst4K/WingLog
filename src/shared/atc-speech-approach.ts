/** Reads the one approach fact BeyondATC's InfoBoxes never carry: "expect radar vectors for ILS-Z approach runway 08". */

import { clearedApproachIdent, type AtcClearanceUpdate } from './atc-info-boxes'
import { VECTORS_TRANSITION } from './route'

/** "expect radar vectors for ILS-Z approach runway 08": the type (hyphenated) and the runway. */
const VECTORS_BRIEFING =
  /\bexpect radar vectors for ([A-Z0-9]+(?:-[A-Z0-9]+)*) approach,? runway (\d{1,2}[LRC]?)\b/i

/**
 * The approach ATC briefed with radar vectors, from one line of the player's own ATC speech, as an update that clears the
 * approach transition to "Vectors" (the route runs from the end of the STAR straight to the approach).
 *
 * Speech is read for this alone because the boxes cannot say it (flight 445, VHHH-ZJSY, 2026-11-21): at the briefing they held
 * the runway, QNH and `Approach Type` "Procedure" (the only value that title has ever shown, with vectors briefed or not), and no
 * box named the approach until `Cleared Approach` six minutes later. A briefed transition needs no speech: its `Transition` box
 * names it, and a transition belongs to one approach only.
 *
 * Only the player's own ATC line may be passed in: another aircraft's briefing in the same words is not this flight's.
 *
 * @param text One line of the player's own ATC speech.
 * @returns The update, or null when the line briefs no approach with vectors.
 */
export function parseAtcVectorsBriefing(text: string): AtcClearanceUpdate | null {
  const match = VECTORS_BRIEFING.exec(text)
  const approachIdent = match ? clearedApproachIdent(`${match[1]} approach runway ${match[2]}`) : null
  if (!approachIdent) return null
  return {
    fields: { approachIdent, approachTransition: VECTORS_TRANSITION },
    summary: `Approach ${approachIdent} via ${VECTORS_TRANSITION}`
  }
}
