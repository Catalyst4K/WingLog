import type { BeyondAtcTranscriptEntry } from '@shared/ipc'

/** A structured snapshot of the pilot's current clearance, boxed out into distinct fields —
 *  flightdeck-backend's docs/plans/beyondatc-panel-redesign.md, item 4: BeyondATC's own
 *  toolbar UI does this today, WingLog's transcript currently just shows the raw `ATC:` line
 *  verbatim. Each field is the *latest* clearance to state it, not a per-phase history — a
 *  departure runway/altitude/squawk and a later arrival runway/approach both just overwrite
 *  the matching field, matching what a pilot glancing at this mid-flight actually wants (the
 *  current clearance), not a permanent log of every phase.
 */
export interface ClearanceReadout {
  runway?: string
  sidIdent?: string
  starIdent?: string
  approachIdent?: string
  approachTransition?: string
  /** The initial climb altitude from the departure clearance ("climb via SID to 11000
   *  feet") — not a live altitude reading. Goes stale once ATC issues further climbs; this
   *  reflects the clearance text, same as every other field here. Only one of this and
   *  `flightLevel` is ever set — whichever the latest departure clearance used. */
  altitudeFt?: number
  /** "climb via SID to FL140" — real phrasing at VHHH, 2026-09-30 (BeyondATC's Player.log). */
  flightLevel?: number
  squawk?: string
  nextFrequencyStation?: string
  nextFrequency?: string
}

// Every regex below is built from real captured clearance text (flightdeck-backend's
// docs/beyondatc-notes.md, "Real SID/STAR/approach clearance samples" and the frequency
// handoff quoted in beyondatc-panel-redesign.md), not assumed phrasing — same discipline
// atcClearanceParser.ts (Part 3) already applies to its own subset of these same fields.
// Departure split into SID/runway plus separately-optional altitude and squawk: one
// all-or-nothing regex dropped a whole real clearance because it said "FL140" rather than
// "11000 feet" (real bug, VHHH, 2026-09-30).
const DEPARTURE = /cleared to .*? via ([A-Z0-9]+) departure, runway (\d{1,2}[LRC]?)/i
const CLIMB_FEET = /climb via sid to (\d{3,6}) feet/i
const CLIMB_FL = /climb via sid to FL ?(\d{2,3})\b/i
const SQUAWK = /squawk (\d{4})/i
const STAR = /cleared ([A-Z0-9]+) arrival, runway (\d{1,2}[LRC]?)/i
const APPROACH_EXPECT = /expect the ([A-Z0-9-]+) approach runway (\d{1,2}[LRC]?)(?: with the ([A-Z0-9]+) transition)?/i
// No need to skip over the "direct <fix>, cross <fix> at or above <alt>," clause explicitly
// — exec() tries every start position, so it naturally finds the second, real "cleared
// <ident> approach runway" occurrence in a message that also says "cleared direct <fix>...".
const APPROACH_CLEARED = /cleared ([A-Z0-9-]+) approach runway (\d{1,2}[LRC]?)/i
const HANDOFF = /contact ([A-Za-z][A-Za-z ]*?) (\d{3}\.\d{1,3})/i

/** The confirmed real transform (docs/beyondatc-notes.md, "Identifier-matching question
 *  closed", 2026-09-28) — BeyondATC speaks the approach type hyphenated ("ILS-Z") with the
 *  runway stated separately; the sim's own navdata wants them space-joined ("ILS Z 17R").
 *  Same transform as atcClearanceParser.ts's reformatApproachIdent, duplicated rather than
 *  imported since that module lives on the still-unmerged Part 3 branch. */
function reformatApproachIdent(type: string, runway: string): string {
  return `${type.replace('-', ' ')} ${runway}`
}

/** Parses one live `ATC:` transcript line into whatever readout fields it states, or `null`
 *  if it matches none of the known real clearance/handoff shapes. Multiple fields from one
 *  message merge together (the departure line alone carries SID/runway/altitude/squawk). */
function parseClearanceLine(text: string): Partial<ClearanceReadout> | null {
  const departure = DEPARTURE.exec(text)
  if (departure) {
    const [, sidIdent, runway] = departure
    const fields: Partial<ClearanceReadout> = { sidIdent, runway }
    const feet = CLIMB_FEET.exec(text)
    const flightLevel = CLIMB_FL.exec(text)
    if (feet) Object.assign(fields, { altitudeFt: Number(feet[1]), flightLevel: undefined })
    else if (flightLevel) Object.assign(fields, { flightLevel: Number(flightLevel[1]), altitudeFt: undefined })
    const squawk = SQUAWK.exec(text)
    if (squawk) fields.squawk = squawk[1]
    return fields
  }

  const star = STAR.exec(text)
  if (star) {
    const [, starIdent, runway] = star
    return { starIdent, runway }
  }

  const expect = APPROACH_EXPECT.exec(text)
  if (expect) {
    const [, type, runway, transition] = expect
    const approachIdent = reformatApproachIdent(type, runway)
    return transition ? { approachIdent, approachTransition: transition, runway } : { approachIdent, runway }
  }

  const cleared = APPROACH_CLEARED.exec(text)
  if (cleared) {
    const [, type, runway] = cleared
    return { approachIdent: reformatApproachIdent(type, runway), runway }
  }

  const handoff = HANDOFF.exec(text)
  if (handoff) {
    const [, station, frequency] = handoff
    return { nextFrequencyStation: station.trim(), nextFrequency: frequency }
  }

  return null
}

/** Folds every `atc`-speaker transcript line into one accumulated readout, latest field
 *  values winning — re-derived from the full transcript each call rather than tracked
 *  incrementally, since `BeyondAtcPanel` already keeps the whole transcript in state and
 *  this has no side effects to dedupe against (unlike atcClearanceParser.ts's App-level
 *  watermark, which guards a one-shot prompt, not a pure display value). */
export function buildClearanceReadout(entries: BeyondAtcTranscriptEntry[]): ClearanceReadout {
  let readout: ClearanceReadout = {}
  for (const entry of entries) {
    if (entry.speaker !== 'atc') continue
    const fields = parseClearanceLine(entry.text)
    if (fields) readout = { ...readout, ...fields }
  }
  // Drop keys explicitly cleared to undefined (altitudeFt vs flightLevel) so callers and
  // equality checks see a clean object.
  for (const key of Object.keys(readout) as (keyof ClearanceReadout)[]) {
    if (readout[key] === undefined) delete readout[key]
  }
  return readout
}
