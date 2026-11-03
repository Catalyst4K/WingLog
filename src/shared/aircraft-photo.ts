/**
 * What an aircraft's photo fields may hold, shared by the picker that makes the pilot's own picture and the validator that checks every
 * save (docs/plans/aircraft-photos.md).
 */

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
