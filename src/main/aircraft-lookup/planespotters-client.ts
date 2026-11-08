/**
 * The newest photo of an aircraft from Planespotters.net's public photo API (docs/plans/aircraft-photos.md): free, no key. Verified
 * against the live service:
 *
 *   GET https://api.planespotters.net/pub/photos/reg/G-EZTK
 *   { "photos": [ { "id": "1947470", "thumbnail": {...}, "thumbnail_large": { "src": "https://t.plnspttrs.net/00978/..._280.jpg",
 *       "size": { "width": 420, "height": 280 } }, "link": "https://www.planespotters.net/photo/1947470/...", "photographer": "..." } ] }
 *
 * An aircraft with no photo, or a registration it doesn't know, answers HTTP 200 with `"photos": []`: the normal "none" outcome.
 * It refuses (HTTP 403) a request whose User-Agent has no contact URL or email: "Server User-Agent strings must include a contact URL or
 * email so we can reach you, e.g. MyFlightTracker/1.2 (+https://example.com/contact)". A reply it already has cached is served whatever the
 * User-Agent, so only an uncached registration shows the refusal; see planespottersUserAgent. Its terms: the photographer's name next to
 * the photo, the photo linked to its page, the links used as given (never proxied or rewritten), and never a paid-only feature. Only links on Planespotters' own hosts are accepted here.
 */
import { isPhotographer, isPlanespottersImage, isPlanespottersPage } from '@shared/aircraft-photo'
import type { PlanespottersPhoto } from '@shared/ipc'

/** Where the photo API is. */
export const PLANESPOTTERS_URL = 'https://api.planespotters.net/pub/photos/reg'

/** Where a contact for WingLog can be found, as Planespotters' User-Agent rule asks. */
export const WINGLOG_CONTACT_URL = 'https://github.com/Catalyst4K/WingLog'

/**
 * The User-Agent every Planespotters request sends: WingLog, its version and a contact URL, as the service requires.
 *
 * @param version WingLog's version.
 * @returns For example `WingLog/1.7.0 (+https://github.com/Catalyst4K/WingLog)`.
 */
export function planespottersUserAgent(version: string): string {
  return `WingLog/${version} (+${WINGLOG_CONTACT_URL})`
}

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

/** How much of a failed reply is kept in the error, in characters: enough to tell a refusal from an outage. */
const REPLY_SNIPPET_CHARS = 160

/**
 * The photos list of a reply's text.
 *
 * @param text The reply's body.
 * @returns The list, or undefined when the text is not JSON or has no list.
 */
function parsePhotos(text: string): unknown[] | undefined {
  try {
    const photos = (JSON.parse(text) as { photos?: unknown } | null)?.photos
    return Array.isArray(photos) ? photos : undefined
  } catch {
    return undefined
  }
}

/**
 * Asks Planespotters for the photo of a registration.
 *
 * @param registration The registration.
 * @param userAgent The User-Agent to send; see planespottersUserAgent.
 * @returns The photo, or null when it has none.
 * @throws PlanespottersError on a failed or malformed reply, including a refusal.
 */
export async function fetchPlanespottersPhoto(
  registration: string,
  userAgent: string
): Promise<PlanespottersPhoto | null> {
  const response = await fetch(`${PLANESPOTTERS_URL}/${encodeURIComponent(registration)}`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(PLANESPOTTERS_TIMEOUT_MS)
  })
  const text = await response.text().catch(() => '')
  const photos = parsePhotos(text)
  if (!response.ok || photos === undefined) {
    const start = text.replace(/\s+/g, ' ').slice(0, REPLY_SNIPPET_CHARS)
    throw new PlanespottersError(
      `Planespotters lookup failed (HTTP ${response.status}) for registration "${registration}": ${start}`
    )
  }
  return readPhoto(photos[0] as PlanespottersEntry | undefined)
}
