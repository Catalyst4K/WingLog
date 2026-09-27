import type { Flight } from '@shared/ipc'

/**
 * The fuel remaining on board after an aircraft's most recent completed flight — so a user
 * who wants realistic fuelling can top up to a plan rather than refuelling from scratch
 * (flightdeck-backend's docs/plans/fleet-maintenance.md, Part 2). `flights` is expected
 * pre-sorted newest-first and already filtered to completed flights, `fleetListFlights`'s
 * own contract (backed by `listFlightsByAircraft`) — so "the last flight was abandoned" is
 * already handled by that filter, not by this function.
 *
 * Deliberately does NOT search further back if the most recent completed flight's
 * `fuelInKg` is null (an older CSV import with no captured fuel data, say): falling back to
 * an earlier flight would silently show a stale number for the wrong flight, which is worse
 * than showing nothing.
 */
export function lastKnownFuelOnBoard(flights: Flight[]): Flight | null {
  const latest = flights[0]
  return latest && latest.fuelInKg != null ? latest : null
}
