/**
 * The one-time pass that gives aircraft looked up before the full-size photo was stored their full-size photo, so the pilot doesn't have
 * to press Look up on each one (docs/plans/aircraft-photos.md). It asks adsbdb, the service Look up uses, one aircraft at a time, and
 * fills only photo fields that are blank.
 */
import { isPhotoUrl } from '@shared/aircraft-photo'
import type { Aircraft, AircraftLookupResult, NewAircraft } from '@shared/ipc'
import { listAircraft, updateAircraft } from '../db/aircraft-repo'
import type { WingLogDb } from '../db/client'
import { getSetting, setSetting } from '../db/settings-repo'
import { logger } from '../logging/logger'
import { fetchAircraftByRegistration } from './adsbdb-client'

/** The setting that records the pass finished, so it never repeats. */
export const PHOTO_BACKFILL_DONE_KEY = 'aircraftPhotoBackfillDone'

/** The wait between two aircraft, in milliseconds: adsbdb is someone else's free service, so the pass is a polite caller. */
export const PHOTO_BACKFILL_PAUSE_MS = 400

/** What the pass needs from outside, so a test can stand in for the network and the clock. */
export interface PhotoBackfillDeps {
  /** Looks a registration up. adsbdb's by default. */
  fetchAircraft?: (registration: string) => Promise<AircraftLookupResult | null>
  /** Waits between two lookups. */
  pause?: (ms: number) => Promise<void>
  /** Called once when at least one aircraft gained a photo, e.g. to push the change to the cloud copy. */
  onChanged?: () => void
}

/**
 * The photo fields an aircraft gains from a lookup: its full-size photo, and its thumbnail if it had none. Links that are not https are
 * not kept.
 *
 * @param aircraft The aircraft.
 * @param found What the lookup answered, or null when it doesn't know the aircraft.
 * @returns The fields to save, or null when the lookup has no full-size photo to give.
 */
function photoFieldsFrom(
  aircraft: Aircraft,
  found: AircraftLookupResult | null
): Pick<NewAircraft, 'photoUrl' | 'photoThumbnailUrl'> | null {
  if (!found?.photoUrl || !isPhotoUrl(found.photoUrl)) return null
  const needsThumbnail =
    aircraft.photoThumbnailUrl === null && !!found.photoThumbnailUrl && isPhotoUrl(found.photoThumbnailUrl)
  return needsThumbnail
    ? { photoUrl: found.photoUrl, photoThumbnailUrl: found.photoThumbnailUrl }
    : { photoUrl: found.photoUrl }
}

/**
 * Fills in the photos of aircraft that have no full-size photo yet, then records the pass as done. An aircraft adsbdb doesn't know is
 * left as it is (a fictional registration has no photo). If any lookup failed (offline, adsbdb down) the pass is not recorded, so the
 * next launch tries again; photos already filled stay filled and are not asked for twice.
 *
 * @param db The database.
 * @param deps The lookup, the wait and the change notice; the real ones by default.
 * @returns How many aircraft gained a photo.
 */
export async function backfillAircraftPhotos(db: WingLogDb, deps: PhotoBackfillDeps = {}): Promise<number> {
  if (getSetting(db, PHOTO_BACKFILL_DONE_KEY) !== undefined) return 0
  const fetchAircraft = deps.fetchAircraft ?? fetchAircraftByRegistration
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const candidates = listAircraft(db).filter((a) => a.photoUrl === null)
  let gained = 0
  let hasFailed = false
  for (const [index, aircraft] of candidates.entries()) {
    if (index > 0) await pause(PHOTO_BACKFILL_PAUSE_MS)
    try {
      const fields = photoFieldsFrom(aircraft, await fetchAircraft(aircraft.registration))
      if (fields === null) continue
      updateAircraft(db, {
        id: aircraft.id,
        registration: aircraft.registration,
        icaoType: aircraft.icaoType,
        ...fields
      })
      gained++
    } catch (error) {
      hasFailed = true
      logger.warn(`[aircraft-photo] lookup for ${aircraft.registration} failed: ${String(error)}`)
    }
  }

  if (!hasFailed) setSetting(db, PHOTO_BACKFILL_DONE_KEY, new Date().toISOString())
  if (gained > 0) deps.onChanged?.()
  return gained
}
