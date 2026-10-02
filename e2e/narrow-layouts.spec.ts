import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch-app'
import { FakeBeyondAtcServer, LARGE_REAL_SNAPSHOT } from './beyondatc-server'
import { FakeGsxRemoteServer, VHHH_BOOT_SNAPSHOT } from './gsx-remote-server'

/**
 * Track, BeyondATC and Ground services at phone and tablet widths (flightdeck-backend's
 * docs/plans/live-data-seam.md, D): a narrow WingLog window on a second monitor now, and the
 * LAN remote's screens later. Layout can't be checked in jsdom, so this runs the real app.
 * Before this, the header's seven labelled tabs were ~1,010 px wide and pushed every page
 * sideways at any width below that.
 */
async function setWidth(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), {
    width,
    height
  })
}

/** Nothing scrolls sideways: not the window, not the header, not the page area under it. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    const header = document.querySelector('header')!
    const content = header.nextElementSibling as HTMLElement
    return {
      document: doc.scrollWidth - doc.clientWidth,
      header: header.scrollWidth - header.clientWidth,
      content: content.scrollWidth - content.clientWidth
    }
  })
  expect(overflow).toEqual({ document: 0, header: 0, content: 0 })
}

for (const [width, height] of [
  [360, 780],
  [768, 1024]
] as const) {
  test(`Track, BeyondATC and Ground services fit a ${width} px window`, async () => {
    const beyondAtc = await FakeBeyondAtcServer.start()
    const gsx = await FakeGsxRemoteServer.start()
    const { app, window: page, cleanup } = await launchApp()
    try {
      await page.evaluate((port) => {
        const api = (globalThis as unknown as Window).winglog
        return Promise.all([
          api.settingsSetBeyondAtc({ enabled: true, host: '127.0.0.1' }),
          api.settingsSetGsxRemote({ enabled: true, host: '127.0.0.1', port })
        ])
      }, gsx.port)
      await beyondAtc.waitForConnection()
      await gsx.waitForConnection()
      beyondAtc.sendLines(...LARGE_REAL_SNAPSHOT)
      gsx.sendSnapshot(VHHH_BOOT_SNAPSHOT)
      await page.reload()
      await setWidth(app, width, height)

      // Every tab is reachable without scrolling the tab row, even with both add-on tabs on.
      await expect(page.getByRole('tab', { name: 'Settings' })).toBeInViewport({ ratio: 1 })

      await page.getByRole('tab', { name: 'Track' }).click()
      await expect(page.getByRole('button', { name: 'Free flight' })).toBeInViewport()
      await expectNoHorizontalScroll(page)

      await page.getByRole('tab', { name: 'BeyondATC' }).click()
      await expect(page.getByRole('button', { name: 'Request IFR Clearance' })).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Set' }).first()).toBeVisible()
      await expectNoHorizontalScroll(page)

      await page.getByRole('tab', { name: 'Ground services' }).click()
      await expect(page.getByText('GSX Menu')).toBeInViewport()
      await expectNoHorizontalScroll(page)

      // The connection badge is still there, just shorter on a phone.
      await expect(page.getByText(width < 640 ? /^disconnected$/ : 'SimConnect: disconnected')).toBeVisible()
    } finally {
      await cleanup()
      await beyondAtc.stop()
      await gsx.stop()
    }
  })
}
