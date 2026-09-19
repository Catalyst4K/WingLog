// Turns raw sim-reported aircraft identity (SimTelemetry's atcId/atcModel/title) into what
// free-flight-tracking.md's start dialog prefills — see that plan's "What the sim actually
// reports" section. Grounded in the real captures in flightdeck-backend's flight-captures/
// (2026-09-14): atcModel comes back either as a raw marketing name ("A350-900") or, for an
// add-on that localises it, a token that still needs unwrapping ("ATCCOM.AC_MODEL
// A320.0.text") — both forms are real, not hypothetical.
import { normalize, searchAircraftTypes } from './icao-types'

const ATCCOM_TOKEN = /^ATCCOM\.AC_MODEL\s+(.+?)\.\d+\.text$/i

function unwrapAtcModel(atcModel: string): string {
  const match = ATCCOM_TOKEN.exec(atcModel.trim())
  return match ? match[1] : atcModel.trim()
}

export interface ParsedAircraftIdentity {
  /** Passed through from atcId untouched — it's the pilot's own MSFS registration
   *  setting, trusted as-is (free-flight-tracking.md finding 2: an earlier draft of that
   *  plan read the Airbus house registrations as untouched defaults worth flagging; Callum
   *  confirmed all three real captures are tails he set himself). */
  registration: string
  /** Best match against the vendored ICAO Doc 8643 list (icao-types.ts's existing
   *  hyphen-insensitive search — no second lookup needed), or null if atcModel's unwrapped
   *  query matched nothing there. */
  icaoType: string | null
  /** True when the query matched more than one distinct ICAO type — the real "A320" case,
   *  which matches both A320 and A20N (A-320neo normalizes to a superstring of it) with
   *  nothing in atcModel saying which. icaoType is still the closest guess, not left blank,
   *  but the caller should have the pilot confirm it once rather than assume it silently. */
  icaoTypeAmbiguous: boolean
}

/**
 * `title` is accepted so a caller can pass a SimTelemetry tick straight through, but plays
 * no part in resolving icaoType here — free-flight-tracking.md finding 1 is explicit that
 * title (an add-on's own display name, e.g. "FenixA320 IAE SL") settles the ambiguity for a
 * human reading it, but nothing about its format is regular enough to resolve it
 * mechanically across every add-on. It remains the right key for the separate title →
 * fleet-aircraft memory (free-flight-tracking.md Phase 2), just not for this function.
 */
export function parseAircraftIdentity(input: {
  atcId: string
  atcModel: string
  title: string
}): ParsedAircraftIdentity {
  const registration = input.atcId.trim()
  const query = unwrapAtcModel(input.atcModel)
  const matches = searchAircraftTypes(query)

  const distinctTypes = [...new Set(matches.map((m) => m.icaoType))]
  if (distinctTypes.length === 0) return { registration, icaoType: null, icaoTypeAmbiguous: false }
  if (distinctTypes.length === 1) return { registration, icaoType: distinctTypes[0], icaoTypeAmbiguous: false }

  // More than one distinct type matched — prefer whichever result's own model normalizes
  // to exactly the query text over a looser substring match (e.g. "A-320" over
  // "A-320neo" for a bare "A320" query); first-loaded wins any further tie, same
  // "don't overthink it" precedent as icao-types.ts's own getWakeCategory.
  const normalizedQuery = normalize(query)
  const exact = matches.find((m) => normalize(m.model) === normalizedQuery)
  return { registration, icaoType: (exact ?? matches[0]).icaoType, icaoTypeAmbiguous: true }
}
