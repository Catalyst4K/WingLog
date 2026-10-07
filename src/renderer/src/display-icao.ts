/**
 * `ZZZZ` — ICAO's own "no location indicator assigned" code — is what a free flight's
 * dep/arr airport reads as when nothing ever resolved (free-flight-tracking.md's "When
 * there's genuinely no airport": main's normalizeFreeFlightIcao for a blank departure, or
 * TrackingController's arrival resolution finding nothing vendored within range at
 * touchdown). Never shown raw to the pilot — this is the one place that decides how.
 *
 * @param icao The stored ICAO code.
 * @returns The code, or "Unknown" for ZZZZ.
 */
export function displayIcao(icao: string): string {
  return icao === 'ZZZZ' ? 'Unknown' : icao
}

/**
 * A real airport code, for anything that looks an airport up — a free flight's unset airports
 * are `ZZZZ`.
 *
 * @param icao A stored ICAO code.
 * @returns It, or null for a missing one or ZZZZ.
 */
export function realIcao(icao: string | null | undefined): string | null {
  return icao && icao !== 'ZZZZ' ? icao : null
}
