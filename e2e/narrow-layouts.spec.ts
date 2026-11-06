import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch-app'
import { FakeBeyondAtcServer, LARGE_REAL_SNAPSHOT } from './beyondatc-server'
import { FakeGsxRemoteServer, VHHH_BOOT_SNAPSHOT } from './gsx-remote-server'

/**
 * Track, BeyondATC and Ground services at phone and tablet widths (winglog-backend's
 * docs/plans/live-data-seam.md, D): a narrow WingLog window on a second monitor now, and the
 * LAN remote's screens later. Layout can't be checked in jsdom, so this runs the real app.
 * Before this, the header's seven labelled tabs were ~1,010 px wide and pushed every page
 * sideways at any width below that.
 */
async function setWidth(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height),
    {
      width,
      height
    }
  )
}

/**
 * Nothing scrolls sideways: not the window, not the header, not the tab row inside it, not the
 * page area under it. The tab row is checked on its own because it scrolls inside itself
 * (min-w-0, overflow-x-auto), so the header never overflows even when the row does — real
 * bug, v1.4.0: at 360 px the row was 16 px short on Linux and Settings was half off screen.
 */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    const header = document.querySelector('header')!
    const tabs = header.querySelector('[role="tablist"]')!
    const content = header.nextElementSibling as HTMLElement
    return {
      document: doc.scrollWidth - doc.clientWidth,
      header: header.scrollWidth - header.clientWidth,
      tabs: tabs.scrollWidth - tabs.clientWidth,
      content: content.scrollWidth - content.clientWidth
    }
  })
  expect(overflow).toEqual({ document: 0, header: 0, tabs: 0, content: 0 })
}

/**
 * Opens a page that is folded behind More in a narrow window (winglog-backend docs/plans/v2-design.md, D9). The More button carries the
 * name of the folded page you are on, so it is found by being the header's popover button, not by its label.
 *
 * @param page The window.
 * @param name The page's name.
 */
async function openFromMore(page: Page, name: string): Promise<void> {
  await page.locator('header button[aria-haspopup="dialog"]').click()
  await page.getByRole('button', { name, exact: true }).click()
}

for (const [width, height] of [
  [360, 780],
  [768, 1024]
] as const) {
  test(`Track, BeyondATC and Ground services fit a ${width} px window`, async () => {
    const beyondAtc = await FakeBeyondAtcServer.start()
    const gsx = await FakeGsxRemoteServer.start()
    const { app, window: page, cleanup } = await launchApp({ env: beyondAtc.env })
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

      // Below 800 px Fleet, Dispatch, Track and Logbook stay in the bar and the rest (Ground services, BeyondATC, Settings) are behind
      // More: the whole bar fits, with nothing scrolled.
      await expect(page.getByRole('tab')).toHaveCount(4)
      await expect(page.locator('header button[aria-haspopup="dialog"]')).toBeInViewport({ ratio: 1 })
      await expectNoHorizontalScroll(page)

      await page.getByRole('tab', { name: 'Track' }).click()
      await expect(page.getByRole('button', { name: 'Free flight' })).toBeInViewport()
      await expectNoHorizontalScroll(page)

      await openFromMore(page, 'BeyondATC')
      await expect(page.getByRole('button', { name: 'Request IFR Clearance' })).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Change' }).first()).toBeVisible()
      await expectNoHorizontalScroll(page)

      await openFromMore(page, 'Ground services')
      await expect(page.getByText('GSX Menu')).toBeInViewport()
      await expectNoHorizontalScroll(page)

      // The sim word and its lights are still in the window (whether the sim is running here doesn't matter).
      await expect(page.locator('header').getByText('Sim', { exact: true })).toBeInViewport({ ratio: 1 })
    } finally {
      await cleanup()
      await beyondAtc.stop()
      await gsx.stop()
    }
  })
}

test('at the default window width every tab label sits on one line, under its underline', async () => {
  // Real bug: lg:not-sr-only reset white-space, so "Ground services" wrapped onto
  // two lines and the active tab's underline ran through "services".
  const gsx = await FakeGsxRemoteServer.start()
  const beyondAtc = await FakeBeyondAtcServer.start()
  const { app, window: page, cleanup } = await launchApp({ env: beyondAtc.env })
  try {
    await page.evaluate((port) => {
      const api = (globalThis as unknown as Window).winglog
      return Promise.all([
        api.settingsSetBeyondAtc({ enabled: true, host: '127.0.0.1' }),
        api.settingsSetGsxRemote({ enabled: true, host: '127.0.0.1', port })
      ])
    }, gsx.port)
    await gsx.waitForConnection()
    await beyondAtc.waitForConnection()
    await page.reload()
    await setWidth(app, 1100, 720)
    await page.getByRole('tab', { name: 'Ground services' }).click()
    const heights = await page
      .getByRole('tab')
      .evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().height))
    expect(heights.length).toBe(7)
    expect(new Set(heights).size).toBe(1)
    // The tab's own text (v2: no icon and no inner span) stays on one line.
    const tab = page.getByRole('tab', { name: 'Ground services' })
    const lineHeight = await tab.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
    expect(await tab.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap')
    expect((await tab.boundingBox())!.height).toBeLessThanOrEqual(lineHeight * 2)
  } finally {
    await cleanup()
    await gsx.stop()
    await beyondAtc.stop()
  }
})
