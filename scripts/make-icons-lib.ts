/**
 * The logo's marks and the pure pieces `npm run make-icons` is built from (winglog-backend's docs/plans/logo-v2.md).
 *
 * `LOGO_LIGHT_SVG` is "a", the one fixed icon; `LOGO_DARK_SVG` is "b", its dark-mode version. This file only builds
 * strings and bytes. Drawing them into PNGs needs Electron and lives in `make-icons.ts`.
 */

/** The W is set in this family, which the app bundles (src/renderer/src/fonts). */
export const LOGO_FONT_FAMILY = 'Golos Text'

/** Light mark "a": a paper tile with an ink border, the plan-magenta bar, an ink W. */
export const LOGO_LIGHT_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="92" height="92" rx="20" fill="#EBE8DE" stroke="#161512" stroke-width="3"/><rect x="16" y="20" width="68" height="9" rx="4.5" fill="#B3146F"/><text x="50" y="81" text-anchor="middle" font-family="'Golos Text', sans-serif" font-weight="700" font-size="58" letter-spacing="-2" fill="#161512">W</text></svg>`

/** Dark mark "b": the same on an ink tile, with the dark theme's plan magenta and a paper W. */
export const LOGO_DARK_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="92" height="92" rx="20" fill="#161512"/><rect x="16" y="20" width="68" height="9" rx="4.5" fill="#E26AAE"/><text x="50" y="81" text-anchor="middle" font-family="'Golos Text', sans-serif" font-weight="700" font-size="58" letter-spacing="-2" fill="#F1EEE6">W</text></svg>`

/**
 * Mark "a" for the iPhone's Home Screen: iOS rounds the corners itself and fills transparent pixels with black, so the
 * paper fills the whole square, with no tile and no border. The bar and the W sit where they do in the tile.
 */
export const LOGO_FULL_BLEED_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="100" height="100" fill="#EBE8DE"/><rect x="16" y="20" width="68" height="9" rx="4.5" fill="#B3146F"/><text x="50" y="81" text-anchor="middle" font-family="'Golos Text', sans-serif" font-weight="700" font-size="58" letter-spacing="-2" fill="#161512">W</text></svg>`

/** The edges, in pixels, of the pictures inside `build/icon.ico`. Every one is the full mark. */
export const ICO_SIZES_PX = [16, 24, 32, 48, 64, 128, 256] as const

/** One picture to put in an .ico file. */
export interface IcoImage {
  /** The picture's edge in pixels, at most 256. */
  sizePx: number
  /** The picture as PNG bytes. */
  png: Uint8Array
}

const ICO_HEADER_BYTES = 6
const ICO_ENTRY_BYTES = 16
/** An .ico entry stores 256 as 0 in its one-byte width and height fields. */
const ICO_MAX_SIZE_PX = 256

/**
 * Builds an .ico file whose entries are PNG pictures (Windows Vista and later read them).
 *
 * @param images The pictures, each at most 256 px.
 * @returns The file's bytes.
 * @throws When there is no picture, or one is larger than 256 px.
 */
export function buildIco(images: IcoImage[]): Buffer {
  if (images.length === 0) throw new Error('An .ico file needs at least one picture')
  const header = Buffer.alloc(ICO_HEADER_BYTES + ICO_ENTRY_BYTES * images.length)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type 1: icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((image, index) => {
    if (image.sizePx > ICO_MAX_SIZE_PX)
      throw new Error(`An .ico picture is at most 256 px, got ${image.sizePx}`)
    const entry = ICO_HEADER_BYTES + ICO_ENTRY_BYTES * index
    const edge = image.sizePx === ICO_MAX_SIZE_PX ? 0 : image.sizePx
    header.writeUInt8(edge, entry) // width
    header.writeUInt8(edge, entry + 1) // height
    header.writeUInt8(0, entry + 2) // palette colours: none
    header.writeUInt8(0, entry + 3) // reserved
    header.writeUInt16LE(1, entry + 4) // colour planes
    header.writeUInt16LE(32, entry + 6) // bits per pixel
    header.writeUInt32LE(image.png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += image.png.length
  })
  return Buffer.concat([header, ...images.map((image) => Buffer.from(image.png))])
}

/**
 * Reads the pictures' sizes out of an .ico file.
 *
 * @param ico The file's bytes.
 * @returns Each picture's width and height in pixels (256 for the stored 0), and whether its bytes are a PNG.
 */
export function readIcoEntries(ico: Uint8Array): { width: number; height: number; isPng: boolean }[] {
  const bytes = Buffer.from(ico)
  const count = bytes.readUInt16LE(4)
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const entries: { width: number; height: number; isPng: boolean }[] = []
  for (let index = 0; index < count; index++) {
    const entry = ICO_HEADER_BYTES + ICO_ENTRY_BYTES * index
    const length = bytes.readUInt32LE(entry + 8)
    const offset = bytes.readUInt32LE(entry + 12)
    entries.push({
      width: bytes.readUInt8(entry) || ICO_MAX_SIZE_PX,
      height: bytes.readUInt8(entry + 1) || ICO_MAX_SIZE_PX,
      isPng: bytes.subarray(offset, offset + 4).equals(pngSignature) && length > 4
    })
  }
  return entries
}

/**
 * Wraps a mark in a page that loads the bundled Golos Text 700 and draws the mark at an exact size.
 *
 * @param svg The mark.
 * @param fontUrl The `file:` URL of the Golos Text 700 latin .woff2.
 * @param sizePx The picture's edge in pixels.
 * @returns The page's HTML.
 */
export function markPage(svg: string, fontUrl: string, sizePx: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: '${LOGO_FONT_FAMILY}'; font-weight: 700; src: url('${fontUrl}') format('woff2'); }
html, body { margin: 0; background: transparent; overflow: hidden; }
svg { display: block; width: ${sizePx}px; height: ${sizePx}px; }
</style></head><body>${svg}</body></html>`
}
