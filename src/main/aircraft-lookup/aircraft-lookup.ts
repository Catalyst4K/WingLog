/**
 * The registration lookup behind the aircraft form's Look up button: the type and operator from adsbdb, the photos from adsbdb and from
 * Planespotters.net. The registration goes to both services, and nowhere else.
 */
import type { AircraftLookupResult } from '@shared/ipc'
import { logger } from '../logging/logger'
import { fetchAircraftByRegistration } from './adsbdb-client'
import { fetchPlanespottersPhoto } from './planespotters-client'

/**
 * Looks a registration up. Planespotters' photo is a bonus: if it fails (refused, offline) the lookup still answers, without it, and
 * says why in the log.
 *
 * @param registration The registration.
 * @param userAgent The User-Agent Planespotters is sent (see planespottersUserAgent).
 * @returns The aircraft, or null when adsbdb doesn't know the registration.
 * @throws When adsbdb fails.
 */
export async function lookupAircraft(
  registration: string,
  userAgent: string
): Promise<AircraftLookupResult | null> {
  const found = await fetchAircraftByRegistration(registration)
  if (!found) return null
  const planespotters = await fetchPlanespottersPhoto(registration, userAgent).catch((error: unknown) => {
    logger.warn(`[aircraft-photo] Planespotters lookup for ${registration} failed: ${String(error)}`)
    return null
  })
  return { ...found, planespotters }
}
