import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { launchApp } from './launch-app'
import { FakeGsxRemoteServer, VHHH_BOOT_SNAPSHOT } from './gsx-remote-server'
import {
  AUTO_SETTINGS_SNAPSHOT,
  FakeBeyondAtcServer,
  FREQUENCIES_RESPONSE,
  RADIO_CHECK_SNAPSHOT
} from './beyondatc-server'

/**
 * The phone page's touch targets and layout at phone and tablet sizes (winglog-backend's docs/plans/lan-web-viewer.md): every button,
 * link and field a thumb has to hit is at least 44 px each way (Apple's and Google's minimum), and no page scrolls sideways. The
 * pages are the real built page, in a hidden window of the app's Chromium, fed by fake GSX and BeyondATC servers carrying real
 * captures. Also writes a picture of each page at each size to release/sim/second-screen-sizes/ (gitignored).
 */

const OUT = 'release/sim/second-screen-sizes'
const MIN_TOUCH = 44

/** The sizes a phone or tablet might use: portrait phone, landscape phone, portrait tablet. */
const SIZES = [
  { name: 'phone-portrait', width: 390, height: 780 },
  { name: 'phone-landscape', width: 780, height: 390 },
  { name: 'tablet-portrait', width: 820, height: 1180 }
] as const

/** The pages on the pages bar, by the name the bar shows. */
const PAGES = ['Track', 'Dispatch', 'Ground services', 'BeyondATC'] as const

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

interface Small {
  what: string
  width: number
  height: number
}

/**
 * @param phone The phone page.
 * @returns The visible controls a thumb has to hit that are smaller than the minimum, and whether the page scrolls sideways.
 */
async function audit(phone: Page): Promise<{ small: Small[]; sideways: boolean }> {
  return phone.evaluate((min) => {
    const selector =
      'button, a[href], select, input, textarea, [role="button"], [role="tab"], [role="combobox"], summary'
    const small: { what: string; width: number; height: number }[] = []
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none')
        continue
      if (element instanceof HTMLInputElement && element.type === 'hidden') continue
      if (Math.round(box.width) < min || Math.round(box.height) < min) {
        const text = (element.getAttribute('aria-label') ?? element.textContent ?? '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 40)
        small.push({
          what: `${element.tagName.toLowerCase()} "${text}"`,
          width: Math.round(box.width),
          height: Math.round(box.height)
        })
      }
    }
    return { small, sideways: document.documentElement.scrollWidth > window.innerWidth + 1 }
  }, MIN_TOUCH)
}

test('the phone page has thumb-sized controls and no sideways scrolling at phone and tablet sizes', async () => {
  test.setTimeout(240_000)
  mkdirSync(OUT, { recursive: true })
  const gsx = await FakeGsxRemoteServer.start()
  const atc = await FakeBeyondAtcServer.start()
  const port = await freePort()
  const {
    app,
    window: page,
    cleanup
  } = await launchApp({
    env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1', ...atc.env }
  })
  try {
    const code = await page.evaluate(
      async (args) => {
        const api = (globalThis as unknown as Window).winglog
        await api.settingsSetGsxRemote({ enabled: true, host: '127.0.0.1', port: args.gsxPort })
        await api.settingsSetBeyondAtc({ enabled: true, host: '127.0.0.1' })
        await api.lanSetSettings({ enabled: true, port: args.port })
        return (await api.lanStartPairing()).pairing?.code ?? ''
      },
      { gsxPort: gsx.port, port }
    )
    expect(code).toMatch(/^\d{6}$/)
    await gsx.waitForConnection()
    await atc.waitForConnection()

    const known = app.windows().length
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const window = new BrowserWindow({ show: false, width: 390, height: 780, useContentSize: true })
      await window.loadURL(url)
    }, `http://127.0.0.1:${port}/#code=${code}`)
    await expect.poll(() => app.windows().length).toBeGreaterThan(known)
    const phone = app.windows().find((w) => w.url().startsWith(`http://127.0.0.1:${port}`))!
    await expect(phone.getByRole('navigation')).toBeVisible()

    gsx.sendSnapshot(VHHH_BOOT_SNAPSHOT)
    atc.sendLines(...RADIO_CHECK_SNAPSHOT)
    await expect.poll(() => atc.receivedCommands).toContain('frequencies')
    atc.sendLines(
      ...FREQUENCIES_RESPONSE,
      ...AUTO_SETTINGS_SNAPSHOT,
      'Progress: {"from": "WSSS", "to": "ZSPD", "pct": 0}'
    )

    const failures: string[] = []
    for (const size of SIZES) {
      await app.evaluate(
        async ({ BrowserWindow }, s) => {
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith(s.origin)
          )!
          window.setContentSize(s.width, s.height)
        },
        { width: size.width, height: size.height, origin: `http://127.0.0.1:${port}` }
      )
      await expect.poll(() => phone.evaluate(() => window.innerWidth)).toBe(size.width)
      for (const name of PAGES) {
        await phone.getByRole('navigation').getByRole('button', { name }).click()
        await phone.waitForTimeout(400)
        await phone.screenshot({
          path: `${OUT}/${size.name}-${name.replace(' ', '-')}.png`,
          animations: 'disabled'
        })
        const { small, sideways } = await audit(phone)
        if (sideways) failures.push(`${size.name} / ${name}: the page scrolls sideways`)
        for (const item of small)
          failures.push(`${size.name} / ${name}: ${item.what} is ${item.width}x${item.height}`)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  } finally {
    await cleanup()
    await gsx.stop()
    await atc.stop()
  }
})
