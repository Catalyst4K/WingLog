/**
 * Reads pixels out of a PNG, for tests that check a picture really is the logo and not just the right size.
 * Handles what Electron's `toPNG` writes: 8-bit RGBA (or RGB), not interlaced.
 */
import { inflateSync } from 'node:zlib'

/** A decoded picture. */
export interface DecodedPng {
  width: number
  height: number
  /** The colour of the pixel at (x, y): `#RRGGBB` and its alpha, 0 to 255. */
  pixel: (x: number, y: number) => { hex: string; alpha: number }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const COLOUR_TYPE_RGB = 2
const COLOUR_TYPE_RGBA = 6

/**
 * Paeth predictor from the PNG specification.
 *
 * @param a The byte to the left.
 * @param b The byte above.
 * @param c The byte above and to the left.
 * @returns The predicted byte.
 */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Decodes a PNG.
 *
 * @param bytes The file's bytes.
 * @returns The picture.
 * @throws When it is not a PNG, or not 8-bit RGB or RGBA without interlacing.
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const data = Buffer.from(bytes)
  if (!PNG_SIGNATURE.every((byte, index) => data[index] === byte)) throw new Error('Not a PNG')
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  const colourType = data[25]
  if (
    data[24] !== 8 ||
    data[28] !== 0 ||
    (colourType !== COLOUR_TYPE_RGB && colourType !== COLOUR_TYPE_RGBA)
  ) {
    throw new Error('Only 8-bit RGB or RGBA PNGs without interlacing are read')
  }
  const channels = colourType === COLOUR_TYPE_RGBA ? 4 : 3
  const chunks: Buffer[] = []
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset)
    if (data.toString('latin1', offset + 4, offset + 8) === 'IDAT')
      chunks.push(data.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]
    for (let column = 0; column < stride; column++) {
      const value = raw[row * (stride + 1) + 1 + column]
      const left = column >= channels ? pixels[row * stride + column - channels] : 0
      const up = row > 0 ? pixels[(row - 1) * stride + column] : 0
      const upLeft = row > 0 && column >= channels ? pixels[(row - 1) * stride + column - channels] : 0
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]
      pixels[row * stride + column] = (value + predictor) & 0xff
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const at = y * stride + x * channels
      const hex = [0, 1, 2].map((i) => pixels[at + i].toString(16).padStart(2, '0')).join('')
      return { hex: `#${hex.toUpperCase()}`, alpha: channels === 4 ? pixels[at + 3] : 255 }
    }
  }
}
