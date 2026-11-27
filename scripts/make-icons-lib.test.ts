import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodePng } from './decode-png'
import { buildIco, ICO_SIZES_PX, LOGO_DARK_SVG, markPage, readIcoEntries } from './make-icons-lib'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]
const fakePng = (length: number): Uint8Array =>
  Uint8Array.from([...PNG_SIGNATURE, ...new Array(length - 4).fill(7)])

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('buildIco', () => {
  it('writes one entry per picture with its size, length and offset, and 256 stored as 0', () => {
    const ico = buildIco([
      { sizePx: 16, png: fakePng(10) },
      { sizePx: 256, png: fakePng(20) }
    ])
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(2)
    expect(ico.readUInt8(6)).toBe(16)
    expect(ico.readUInt8(6 + 16)).toBe(0)
    expect(ico.readUInt32LE(6 + 8)).toBe(10)
    expect(ico.readUInt32LE(6 + 12)).toBe(38)
    expect(ico.readUInt32LE(6 + 16 + 12)).toBe(48)
    expect(ico.length).toBe(38 + 10 + 20)
    expect(readIcoEntries(ico)).toEqual([
      { width: 16, height: 16, isPng: true },
      { width: 256, height: 256, isPng: true }
    ])
  })

  it('refuses no pictures, and a picture over 256 px', () => {
    expect(() => buildIco([])).toThrow('at least one')
    expect(() => buildIco([{ sizePx: 512, png: fakePng(8) }])).toThrow('at most 256')
  })
})

describe('markPage', () => {
  it('draws the mark into a page that loads the bundled font file at the size asked for', () => {
    const page = markPage(LOGO_DARK_SVG, 'file:///fonts/golos.woff2', 48)
    expect(page).toContain("src: url('file:///fonts/golos.woff2')")
    expect(page).toContain('width: 48px; height: 48px')
    expect(page).toContain(LOGO_DARK_SVG)
  })
})

describe('the icon files in the repo', () => {
  const root = join(__dirname, '..')

  it('holds every size in build/icon.ico as a PNG, 16 to 256 px', () => {
    for (const name of ['icon.ico', 'icon-dark.ico']) {
      const entries = readIcoEntries(readFileSync(join(root, 'build', name)))
      expect(
        entries.map((entry) => entry.width),
        name
      ).toEqual([...ICO_SIZES_PX])
      for (const entry of entries) {
        expect(entry.height).toBe(entry.width)
        expect(entry.isPng).toBe(true)
      }
    }
  })

  it('draws the light mark in icon.png and icon.ico and the dark mark in icon-dark.png and icon-dark.ico', () => {
    const lightBar = '#B3146F'
    const darkBar = '#E26AAE'
    const barOf = (png: Uint8Array): string => {
      const picture = decodePng(png)
      return picture.pixel(picture.width / 2, Math.floor(picture.height * 0.245)).hex
    }
    const biggestIcoPicture = (name: string): Uint8Array => {
      const ico = readFileSync(join(root, 'build', name))
      const last = 6 + 16 * (ico.readUInt16LE(4) - 1)
      return ico.subarray(
        ico.readUInt32LE(last + 12),
        ico.readUInt32LE(last + 12) + ico.readUInt32LE(last + 8)
      )
    }
    expect(barOf(readFileSync(join(root, 'build', 'icon.png')))).toBe(lightBar)
    expect(barOf(readFileSync(join(root, 'build', 'icon-dark.png')))).toBe(darkBar)
    expect(barOf(biggestIcoPicture('icon.ico'))).toBe(lightBar)
    expect(barOf(biggestIcoPicture('icon-dark.ico'))).toBe(darkBar)
    const dark = decodePng(readFileSync(join(root, 'build', 'icon-dark.png')))
    expect(dark.pixel(512, 900).hex).toBe('#161512')
  })

  it('has the light and dark source pictures at 1024 px', () => {
    expect(pngSize(join(root, 'build', 'icon.png'))).toEqual({ width: 1024, height: 1024 })
    expect(pngSize(join(root, 'build', 'icon-dark.png'))).toEqual({ width: 1024, height: 1024 })
  })
})
