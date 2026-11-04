/**
 * What an aircraft's photo fields may hold, shared by the picker that makes the pilot's own picture and the validator that checks every
 * save (docs/plans/aircraft-photos.md).
 */
import type { Aircraft, PlanespottersPhoto } from './types/aircraft'

/** The longest side of the pilot's own picture once shrunk, in pixels. Big enough for the detail page at any window size. */
export const CUSTOM_PHOTO_MAX_EDGE_PX = 1280

/** The JPEG quality the pilot's own picture is saved at, 1 to 100. */
export const CUSTOM_PHOTO_JPEG_QUALITY = 85

/** The largest file the pilot may choose, in bytes. It is read whole into memory before it is shrunk. */
export const CUSTOM_PHOTO_MAX_FILE_BYTES = 25 * 1024 * 1024

/** The longest data URL kept for the pilot's own picture, in characters. A 1280 px JPEG is a few hundred thousand; this is the ceiling. */
export const CUSTOM_PHOTO_MAX_CHARS = 1_500_000

/** The longest photo link kept for a looked-up photo, in characters. */
export const PHOTO_URL_MAX_CHARS = 2048

/** The shape (width over height) of the large photo's box until the picture has loaded and its own shape is known: 3:2, a camera's. */
export const PHOTO_BOX_DEFAULT_RATIO = 3 / 2

/** The tallest shape the large photo's box takes (width over height): 6:5. A taller picture is shown whole on a neutral band. */
export const PHOTO_BOX_MIN_RATIO = 6 / 5

/** The widest shape the large photo's box takes (width over height): 3:1. A wider picture is shown whole on a neutral band. */
export const PHOTO_BOX_MAX_RATIO = 3

/**
 * The shape the large photo's box takes for a picture: the picture's own, so that it fills the box exactly with nothing cropped,
 * unless that is more extreme than a card can sensibly hold.
 *
 * @param pictureRatio The picture's width over its height.
 * @returns The box's width over its height, between PHOTO_BOX_MIN_RATIO and PHOTO_BOX_MAX_RATIO.
 */
export function photoBoxRatio(pictureRatio: number): number {
  return Math.min(PHOTO_BOX_MAX_RATIO, Math.max(PHOTO_BOX_MIN_RATIO, pictureRatio))
}

/** Where Planespotters' images are served from, and where its photo pages are. A stored link on any other host is refused. */
export const PLANESPOTTERS_IMAGE_HOST = 't.plnspttrs.net'
export const PLANESPOTTERS_PAGE_HOST = 'www.planespotters.net'

/** The longest photographer name kept, in characters. */
export const PHOTOGRAPHER_MAX_CHARS = 120

/** How the pilot's own picture starts: the only form it is ever saved in. */
export const CUSTOM_PHOTO_PREFIX = 'data:image/jpeg;base64,'

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Whether a value is something the pilot's own picture may hold: a JPEG data URL of a sensible length.
 *
 * @param value The value to check.
 * @returns True when it is a base64 JPEG data URL within the limit.
 */
export function isCustomPhoto(value: string): boolean {
  return (
    value.length <= CUSTOM_PHOTO_MAX_CHARS &&
    value.startsWith(CUSTOM_PHOTO_PREFIX) &&
    BASE64.test(value.slice(CUSTOM_PHOTO_PREFIX.length))
  )
}

/**
 * Whether a value is something a looked-up photo may hold: an `https:` link of a sensible length.
 *
 * @param value The value to check.
 * @returns True when it parses as an https URL within the limit.
 */
export function isPhotoUrl(value: string): boolean {
  if (value.length > PHOTO_URL_MAX_CHARS) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Whether a value is an https link on a given host and of a sensible length.
 *
 * @param value The value to check.
 * @param host The host it must be on.
 * @returns True when it is.
 */
function isHttpsLinkOn(value: string, host: string): boolean {
  if (!isPhotoUrl(value)) return false
  return new URL(value).hostname === host
}

/**
 * Whether a value is a Planespotters image link: https, on their image host.
 *
 * @param value The value to check.
 * @returns True when it is.
 */
export function isPlanespottersImage(value: string): boolean {
  return isHttpsLinkOn(value, PLANESPOTTERS_IMAGE_HOST)
}

/**
 * Whether a value is a Planespotters photo page: https, on planespotters.net. Only such a link is ever opened in the browser.
 *
 * @param value The value to check.
 * @returns True when it is.
 */
export function isPlanespottersPage(value: string): boolean {
  return isHttpsLinkOn(value, PLANESPOTTERS_PAGE_HOST)
}

/**
 * Whether a value is a photographer's name worth keeping: some text, not too long, with no control characters.
 *
 * @param value The value to check.
 * @returns True when it is.
 */
export function isPhotographer(value: string): boolean {
  const hasControlCharacter = [...value].some(
    (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f
  )
  return value.trim().length > 0 && value.length <= PHOTOGRAPHER_MAX_CHARS && !hasControlCharacter
}

/** What the picture of an aircraft can be, in the order it is tried: the pilot's own, Planespotters', airport-data's full size and thumbnail. */
export interface AircraftPhotoSources {
  customPhoto: string | null
  planespotters: PlanespottersPhoto | null
  photoUrl: string | null
  thumbnailUrl: string | null
}

/**
 * The photo sources an aircraft has.
 *
 * @param a The aircraft's photo fields.
 * @returns The sources; Planespotters' only when all three of its fields are there.
 */
export function photoSourcesOf(
  a: Pick<
    Aircraft,
    | 'customPhoto'
    | 'planespottersPhotoUrl'
    | 'planespottersPhotographer'
    | 'planespottersPageUrl'
    | 'photoUrl'
    | 'photoThumbnailUrl'
  >
): AircraftPhotoSources {
  const {
    planespottersPhotoUrl: photoUrl,
    planespottersPhotographer: photographer,
    planespottersPageUrl: pageUrl
  } = a
  return {
    customPhoto: a.customPhoto,
    planespotters: photoUrl && photographer && pageUrl ? { photoUrl, photographer, pageUrl } : null,
    photoUrl: a.photoUrl,
    thumbnailUrl: a.photoThumbnailUrl
  }
}
