import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every icon the phone's page and manifest name must exist, be a PNG, and be the size it claims: the iPhone's Home Screen icon once stayed
// on an older logo because nothing checked it (winglog-backend's docs/plans/logo-v2.md).
const folder = join(__dirname, '..', '..', 'lan-client')
const publicFolder = join(folder, 'public')
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function readPng(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  expect([...bytes.subarray(0, 8)], `${path} is a PNG`).toEqual(PNG_SIGNATURE)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('the phone page’s icons', () => {
  it('has every manifest icon as a PNG of the size its entry claims', () => {
    const manifest = JSON.parse(readFileSync(join(publicFolder, 'manifest.webmanifest'), 'utf8')) as {
      icons: { src: string; sizes: string; type: string }[]
    }
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      const path = join(publicFolder, icon.src.replace('./', ''))
      expect(existsSync(path), icon.src).toBe(true)
      expect(icon.type).toBe('image/png')
      const [edge] = icon.sizes.split('x').map(Number)
      expect(readPng(path), icon.src).toEqual({ width: edge, height: edge })
    }
  })

  it('has every icon index.html links as a PNG, and the touch icon is 180 px square', () => {
    const html = readFileSync(join(folder, 'index.html'), 'utf8')
    const hrefs = [...html.matchAll(/<link rel="(?:apple-touch-icon|icon)"[^>]*href="([^"]+)"/g)].map(
      (match) => match[1]
    )
    expect(hrefs).toContain('./apple-touch-icon.png')
    for (const href of hrefs) {
      const path = join(publicFolder, href.replace('./', ''))
      expect(existsSync(path), href).toBe(true)
      expect(readPng(path).width, href).toBeGreaterThan(0)
    }
    expect(readPng(join(publicFolder, 'apple-touch-icon.png'))).toEqual({ width: 180, height: 180 })
  })
})
