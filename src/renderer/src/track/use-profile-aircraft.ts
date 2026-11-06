/** The aircraft's place for the route profile, from the live telemetry. */

import { useMemo } from 'react'
import type { SimTelemetry } from '@shared/ipc'
import { mToFt } from '@shared/units'

/**
 * @param telemetry The sim's latest reading, or null/undefined when there is none.
 * @param tracking Whether a flight is being tracked: only then is the aircraft shown (before that the sim can hold stale values).
 * @returns The aircraft's position and altitude for the profile, kept the same object while the reading is.
 */
export function useProfileAircraft(
  telemetry: SimTelemetry | null | undefined,
  tracking: boolean
): { lon: number; lat: number; altitudeFt: number } | null {
  return useMemo(
    () =>
      tracking && telemetry
        ? { lon: telemetry.longitude, lat: telemetry.latitude, altitudeFt: mToFt(telemetry.altitudeM) }
        : null,
    [telemetry, tracking]
  )
}
