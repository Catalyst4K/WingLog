/**
 * The newest photo of an aircraft from Planespotters.net's public photo API (docs/plans/aircraft-photos.md): free, no key. Verified
 * against the live service:
 *
 *   GET https://api.planespotters.net/pub/photos/reg/G-EZTK
 *   { "photos": [ { "id": "1947470", "thumbnail": {...}, "thumbnail_large": { "src": "https://t.plnspttrs.net/00978/..._280.jpg",
 *       "size": { "width": 420, "height": 280 } }, "link": "https://www.planespotters.net/photo/1947470/...", "photographer": "..." } ] }
 *
 * An aircraft with no photo, or a registration it doesn't know, answers HTTP 200 with `"photos": []`: the normal "none" outcome.
 * Requests closer than about a second apart get HTTP 403 from its Cloudflare, and generic library User-Agents may be blocked, so every
 * request names WingLog. Its terms: the photographer's name next to the photo, the photo linked to its page, the links used as given
 * (never proxied or rewritten), and never a paid-only feature. Only links on Planespotters' own hosts are accepted here.
 */
import { isPhotographer, isPlanespottersImage, isPlanespottersPage } from '@shared/aircraft-photo'
import type { PlanespottersPhoto } from '@shared/ipc'

/** Where the photo API is. */
export const PLANESPOTTERS_URL = 'https://api.planespotters.net/pub/photos/reg'

/** How long to wait for it, in milliseconds. */
export const PLANESPOTTERS_TIMEOUT_MS = 10_000

class PlanespottersError extends Error {}

interface PlanespottersEntry {
  thumbnail_large?: { src?: unknown }
  link?: unknown
  photographer?: unknown
}

/**
 * Reads the first photo of a reply, defensively: a field of the wrong type or on the wrong host means no photo, not an error.
 *
 * @param entry The reply's first photo.
 * @returns The photo, or null when it is missing a part or a part is not acceptable.
 */
function readPhoto(entry: PlanespottersEntry | undefined): PlanespottersPhoto | null {
  const photoUrl = entry?.thumbnail_large?.src
  const pageUrl = entry?.link
  const photographer = entry?.photographer
  if (typeof photoUrl !== 'string' || !isPlanespottersImage(photoUrl)) return null
  if (typeof pageUrl !== 'string' || !isPlanespottersPage(pageUrl)) return null
  if (typeof photographer !== 'string' || !isPhotographer(photographer)) return null
  return { photoUrl, pageUrl, photographer: photographer.trim() }
}

/**
 * Asks Planespotters for the photo of a registration.
 *
 * @param registration The registration.
 * @param userAgent The User-Agent to send, naming WingLog.
 * @returns The photo, or null when it has none.
 * @throws PlanespottersError on a failed or malformed reply, including a rate-limit refusal.
 */
export async function fetchPlanespottersPhoto(
  registration: string,
  userAgent: string
): Promise<PlanespottersPhoto | null> {
  const response = await fetch(`${PLANESPOTTERS_URL}/${encodeURIComponent(registration)}`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(PLANESPOTTERS_TIMEOUT_MS)
  })
  const raw: unknown = await response.json().catch(() => undefined)
  const photos = (raw as { photos?: unknown } | null | undefined)?.photos
  if (!response.ok || !Array.isArray(photos)) {
    throw new PlanespottersError(
      `Planespotters lookup failed (HTTP ${response.status}) for registration "${registration}"`
    )
  }
  return readPhoto(photos[0] as PlanespottersEntry | undefined)
}
