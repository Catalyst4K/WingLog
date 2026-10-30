import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * A traffic aircraft's popup, in dark mode. MapLibre paints its box and pointer white, and the text inherits the app's light
 * colour, so the text could not be read (Callum, 2026-10-26). A click on a canvas symbol can't be driven here, so this builds
 * the same markup MapLibre does inside the real map and checks the colours the built app's real CSS gives it.
 */
async function popupColours(page: import('@playwright/test').Page): Promise<{
  box: string
  text: string
  tip: string
}> {
  return page.evaluate(() => {
    const host = document.querySelector('.maplibregl-map') ?? document.body
    const popup = document.createElement('div')
    popup.className = 'maplibregl-popup maplibregl-popup-anchor-bottom'
    popup.innerHTML =
      '<div class="maplibregl-popup-tip"></div><div class="maplibregl-popup-content">BAW123</div>'
    host.appendChild(popup)
    const style = (selector: string): CSSStyleDeclaration =>
      getComputedStyle(popup.querySelector(selector) as Element)
    const colours = {
      box: style('.maplibregl-popup-content').backgroundColor,
      text: style('.maplibregl-popup-content').color,
      tip: style('.maplibregl-popup-tip').borderTopColor
    }
    popup.remove()
    return colours
  })
}

test('the aircraft popup is readable in dark mode and unchanged in light', async () => {
  const { window: page, cleanup } = await launchApp()
  try {
    await page.getByRole('tab', { name: 'Track' }).click()
    await expect(page.locator('.maplibregl-map')).toBeVisible()

    await page.evaluate(() => document.documentElement.classList.remove('dark'))
    const light = await popupColours(page)
    expect(light.box).toBe('rgb(255, 255, 255)')
    expect(light.tip).toBe('rgb(255, 255, 255)')

    await page.evaluate(() => document.documentElement.classList.add('dark'))
    const dark = await popupColours(page)
    expect(dark.box).not.toBe('rgb(255, 255, 255)')
    expect(dark.tip).toBe(dark.box)
    expect(dark.text).not.toBe(dark.box)
    // light text on a dark box, not the white-on-white of before
    const brightness = (rgb: string): number =>
      rgb
        .match(/\d+/g)!
        .slice(0, 3)
        .reduce((sum, n) => sum + Number(n), 0)
    expect(brightness(dark.text)).toBeGreaterThan(brightness(dark.box) + 300)
  } finally {
    await cleanup()
  }
})
