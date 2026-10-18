/** What FlightMap works out from its props each render, with no map involved. */

import type { SimTelemetry } from '@shared/ipc'

/**
 * Whether the map should show yet. Track's map stays hidden only while it's about to frame an
 * aircraft it's following; everything else (Logbook, follow off, no flight to follow) shows
 * straight away.
 *
 * @param state Whether live, whether it has framed the aircraft, whether following, whether the
 *   track is still loading, and whether there's an aircraft.
 * @returns True to show the map.
 */
export function isMapVisible(state: {
  live: boolean
  framed: boolean
  followEnabled: boolean
  trackLoading: boolean
  hasAircraft: boolean
}): boolean {
  return !state.live || state.framed || !state.followEnabled || (!state.trackLoading && !state.hasAircraft)
}

/**
 * The aircraft's position as the taxi route highlight wants it.
 *
 * @param telemetry The live telemetry, if any.
 * @returns The position, or null with no telemetry.
 */
export function taxiPosition(
  telemetry: SimTelemetry | null | undefined
): { lat: number; lon: number; headingDeg: number; groundSpeedMs: number } | null {
  return telemetry
    ? {
        lat: telemetry.latitude,
        lon: telemetry.longitude,
        headingDeg: telemetry.headingTrueDeg,
        groundSpeedMs: telemetry.groundSpeedMs
      }
    : null
}
