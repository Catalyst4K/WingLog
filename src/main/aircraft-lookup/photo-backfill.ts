/**
 * The one-time pass that gives the aircraft already in the fleet their newer photos, so the pilot doesn't have to press Look up on each
 * one (docs/plans/aircraft-photos.md): the full-size airport-data photo from adsbdb, and the Planespotters.net photo. One aircraft at a
 * time, filling only photo fields that are blank.
 */
import { isPhotoUrl } from '@shared/aircraft-photo'
import type { Aircraft, NewAircraft, PlanespottersPhoto } from '@shared/ipc'
import { listAircraft, updateAircraft } from '../db/aircraft-repo'
import type { WingLogDb } from '../db/client'
import { getSetting, setSetting } from '../db/settings-repo'
import { logger } from '../logging/logger'
import { fetchAircraftByRegistration, type AdsbdbResult } from './adsbdb-client'
import { fetchPlanespottersPhoto } from './planespotters-client'

/** The setting that records the pass finished, so it never repeats. (An earlier pass that only asked adsbdb used another key.) */
export const PHOTO_BACKFILL_DONE_KEY = 'aircraftPhotosBackfillDone'

/** The wait between two aircraft, in milliseconds: Planespotters refuses requests closer than about a second, and both are free services. */
export const PHOTO_BACKFILL_PAUSE_MS = 3000

/** What the pass needs from outside, so a test can stand in for the network and the clock. */
export interface PhotoBackfillDeps {
  /** Looks a registration up on adsbdb. */
  fetchAircraft?: (registration: string) => Promise<AdsbdbResult | null>
  /** Asks Planespotters for a registration's photo. */
  fetchPlanespotters?: (registration: string) => Promise<PlanespottersPhoto | null>
  /** Waits between two aircraft. */
  pause?: (ms: number) => Promise<void>
  /** Called once when at least one aircraft gained a photo, e.g. to push the change to the cloud copy. */
  onChanged?: () => void
  /** The User-Agent Planespotters is sent, naming WingLog. */
  userAgent?: string
}

type PhotoFields = Pick<
  NewAircraft,
  | 'photoUrl'
  | 'photoThumbnailUrl'
  | 'planespottersPhotoUrl'
  | 'planespottersPhotographer'
  | 'planespottersPageUrl'
>

/**
 * The photo fields an aircraft gains from adsbdb: its full-size photo, and its thumbnail if it had none. Links that are not https are
 * not kept.
 *
 * @param aircraft The aircraft.
 * @param found What adsbdb answered, or null when it doesn't know the aircraft.
 * @returns The fields to save; empty when adsbdb has no full-size photo to give.
 */
function airportDataFields(aircraft: Aircraft, found: AdsbdbResult | null): PhotoFields {
  if (!found?.photoUrl || !isPhotoUrl(found.photoUrl)) return {}
  const needsThumbnail =
    aircraft.photoThumbnailUrl === null && !!found.photoThumbnailUrl && isPhotoUrl(found.photoThumbnailUrl)
  return needsThumbnail
    ? { photoUrl: found.photoUrl, photoThumbnailUrl: found.photoThumbnailUrl }
    : { photoUrl: found.photoUrl }
}

/**
 * Asks the services for what an aircraft is missing. A service that fails leaves its fields out and says so, and the other is still asked.
 *
 * @param aircraft The aircraft.
 * @param deps The two lookups and the User-Agent.
 * @returns The fields gained, and whether either lookup failed.
 */
async function photosFor(
  aircraft: Aircraft,
  deps: Required<Pick<PhotoBackfillDeps, 'fetchAircraft' | 'fetchPlanespotters'>>
): Promise<{ fields: PhotoFields; hasFailed: boolean }> {
  const fields: PhotoFields = {}
  let hasFailed = false
  try {
    if (aircraft.photoUrl === null) {
      Object.assign(fields, airportDataFields(aircraft, await deps.fetchAircraft(aircraft.registration)))
    }
    if (aircraft.planespottersPhotoUrl === null) {
      const found = await deps.fetchPlanespotters(aircraft.registration)
      if (found) {
        Object.assign(fields, {
          planespottersPhotoUrl: found.photoUrl,
          planespottersPhotographer: found.photographer,
          planespottersPageUrl: found.pageUrl
        })
      }
    }
  } catch (error) {
    hasFailed = true
    logger.warn(`[aircraft-photo] lookup for ${aircraft.registration} failed: ${String(error)}`)
  }
  return { fields, hasFailed }
}

/**
 * Fills in the photos aircraft are missing, then records the pass as done. An aircraft a service doesn't know is left as it is (a
 * fictional registration has no photo). If any lookup failed (offline, rate-limited) the pass is not recorded, so the next launch tries
 * again; photos already filled stay filled and are not asked for twice.
 *
 * @param db The database.
 * @param deps The lookups, the wait and the change notice; the real ones by default.
 * @returns How many aircraft gained a photo.
 */
export async function backfillAircraftPhotos(db: WingLogDb, deps: PhotoBackfillDeps = {}): Promise<number> {
  if (getSetting(db, PHOTO_BACKFILL_DONE_KEY) !== undefined) return 0
  const fetchAircraft = deps.fetchAircraft ?? fetchAircraftByRegistration
  const userAgent = deps.userAgent ?? 'WingLog'
  const fetchPlanespotters =
    deps.fetchPlanespotters ?? ((registration: string) => fetchPlanespottersPhoto(registration, userAgent))
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const candidates = listAircraft(db).filter((a) => a.photoUrl === null || a.planespottersPhotoUrl === null)
  let gained = 0
  let hasFailed = false
  for (const [index, aircraft] of candidates.entries()) {
    if (index > 0) await pause(PHOTO_BACKFILL_PAUSE_MS)
    const result = await photosFor(aircraft, { fetchAircraft, fetchPlanespotters })
    hasFailed ||= result.hasFailed
    if (Object.keys(result.fields).length === 0) continue
    updateAircraft(db, {
      id: aircraft.id,
      registration: aircraft.registration,
      icaoType: aircraft.icaoType,
      ...result.fields
    })
    gained++
  }

  if (!hasFailed) setSetting(db, PHOTO_BACKFILL_DONE_KEY, new Date().toISOString())
  if (gained > 0) deps.onChanged?.()
  return gained
}
