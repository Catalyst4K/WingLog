import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The page saved to a phone's Home Screen: the icon, name and full-screen mode come from these files, which nothing else exercises.
const folder = join(__dirname, '..', '..', 'lan-client')
const html = readFileSync(join(folder, 'index.html'), 'utf8')
const manifest = JSON.parse(readFileSync(join(folder, 'public', 'manifest.webmanifest'), 'utf8')) as {
  name: string
  start_url: string
  display: string
  icons: { src: string; sizes: string }[]
}

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('Home Screen web app', () => {
  it('links the manifest and a 180 px touch icon that exist, and names the app WingLog', () => {
    expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />')
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="WingLog" />')
    expect(pngSize(join(folder, 'public', 'apple-touch-icon.png'))).toEqual({ width: 180, height: 180 })
  })

  it('opens full screen at the page itself, with icons of the sizes it claims', () => {
    expect(manifest).toMatchObject({ name: 'WingLog', start_url: './', display: 'standalone' })
    for (const icon of manifest.icons) {
      const path = join(folder, 'public', icon.src.replace('./', ''))
      expect(existsSync(path), icon.src).toBe(true)
      const [width] = icon.sizes.split('x').map(Number)
      expect(pngSize(path)).toEqual({ width, height: width })
    }
  })

  it('lets the page extend under the status bar, and pads for it with extra room below the blurred band iOS draws there', () => {
    expect(html).toContain('viewport-fit=cover')
    const app = readFileSync(join(folder, 'LanApp.tsx'), 'utf8')
    const css = readFileSync(join(folder, 'lan.css'), 'utf8')
    expect(app).toContain('lan-shell')
    expect(css).toMatch(/\.lan-shell\s*\{\s*padding-top: env\(safe-area-inset-top/)
    expect(css).toMatch(
      /@media \(display-mode: standalone\)\s*\{\s*\.lan-shell\s*\{\s*padding-top: calc\(env\(safe-area-inset-top/
    )
  })

  it('keeps the map’s (i) in its corner when its text is open', () => {
    const css = readFileSync(join(folder, 'lan.css'), 'utf8')
    expect(css).toMatch(/\.maplibregl-compact-show \.maplibregl-ctrl-attrib-button\s*\{\s*inset: -6px -6px auto auto;/)
  })

  it('draws the (i) as a small circle that clears the readout, with a full-size touch button over it', () => {
    const css = readFileSync(join(folder, 'lan.css'), 'utf8')
    expect(css).toMatch(/\.maplibregl-ctrl-attrib\.maplibregl-compact\s*\{[^}]*min-width: 32px;[^}]*min-height: 32px;/)
    // The button is 44 px (the touch minimum) and reaches 6 px past the 32 px circle on every side: nothing is drawn out there.
    expect(css).toMatch(/#root \.maplibregl-ctrl-attrib-button\s*\{\s*inset: -6px;\s*width: 44px;\s*height: 44px;/)
  })
})
