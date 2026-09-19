/**
 * `ZZZZ` — ICAO's own "no location indicator assigned" code — is what a free flight's
 * dep/arr airport reads as when nothing ever resolved (free-flight-tracking.md's "When
 * there's genuinely no airport": main's normalizeFreeFlightIcao for a blank departure, or
 * TrackingController's arrival resolution finding nothing vendored within range at
 * touchdown). Never shown raw to the pilot — this is the one place that decides how.
 */
export function displayIcao(icao: string): string {
  return icao === 'ZZZZ' ? 'Unknown' : icao
}
