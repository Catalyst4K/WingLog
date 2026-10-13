import { createServer } from 'node:net'
import { expect, test, type Page } from '@playwright/test'
import { WebSocket } from 'ws'
import { launchApp } from './launch-app'
import { FakeGsxRemoteServer, VHHH_BOOT_SNAPSHOT } from './gsx-remote-server'

/**
 * The second screen (winglog-backend's docs/plans/lan-web-viewer.md) through a real launched app: switching it on in Settings, pairing a
 * device with the code the PC shows, the page it serves, and revoking the device. The server listens on loopback here (the app's
 * WINGLOG_E2E_LAN_ADDRESS, honoured by an unpackaged build only), so no real network or firewall is touched.
 */

/** A port nothing listens on. */
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

/** A device talking to the PC the way the page does, remembering what it was sent. */
class Device {
  readonly received: Record<string, unknown>[] = []
  closed = false
  private readonly ws: WebSocket

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/live`)
    this.ws.on('message', (data) => this.received.push(JSON.parse(data.toString())))
    this.ws.on('close', () => (this.closed = true))
    this.ws.on('error', () => undefined)
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message))
  }

  async message(type: string): Promise<Record<string, unknown>> {
    await expect.poll(() => this.received.some((m) => m.t === type)).toBe(true)
    return this.received.find((m) => m.t === type) as Record<string, unknown>
  }

  close(): void {
    this.ws.terminate()
  }
}

/**
 * Switches the second screen on in Settings, on a free port.
 *
 * @param page The app window.
 * @param port The port to listen on.
 * @returns The card.
 */
async function switchOn(page: Page, port: number) {
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByRole('tab', { name: 'Data' }).click()
  const card = page.locator('[data-slot="card"]').filter({ hasText: 'Second screen' })
  await card.getByRole('button', { name: 'On', exact: true }).click()
  const portBox = card.getByRole('textbox', { name: 'Port' })
  await portBox.fill(String(port))
  await portBox.blur()
  await expect(card.getByText(`http://127.0.0.1:${port}/`)).toBeVisible()
  return card
}

test.describe('Second screen', () => {
  test('is off until switched on, then serves the page and pairs a device with the code', async () => {
    const port = await freePort()
    const { window: page, cleanup } = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: 'Data' }).click()
      const card = page.locator('[data-slot="card"]').filter({ hasText: 'Second screen' })
      await expect(card.getByRole('button', { name: 'Off', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await expect(card.getByText('Pair a device')).toHaveCount(0)
      await expect(card.getByRole('img')).toHaveCount(0)

      await switchOn(page, port)

      // The address as a QR code to scan: drawn, and holding more than a blank square.
      const qr = card.getByRole('img', { name: 'QR code for the second-screen address' })
      await expect(qr).toBeVisible()
      expect(await qr.locator('path').getAttribute('d')).toMatch(/^M\d+ \d+h\d+v1/)

      // The page itself carries no data, and anything else is not found.
      const html = await fetch(`http://127.0.0.1:${port}/`)
      expect(html.status).toBe(200)
      expect(await html.text()).toContain('<div id="root">')
      expect((await fetch(`http://127.0.0.1:${port}/etc/passwd`)).status).toBe(404)

      // Pairing: the code on the PC, typed on the device.
      await card.getByRole('button', { name: 'Pair a device' }).click()
      const code =
        (await card
          .locator('[aria-label]')
          .filter({ hasText: /^\d{6}$/ })
          .textContent()) ?? ''
      expect(code).toMatch(/^\d{6}$/)

      const wrong = new Device(port)
      await wrong.opened()
      wrong.send({ t: 'pair', code: code === '000000' ? '111111' : '000000', name: 'Other' })
      await wrong.message('denied')

      const device = new Device(port)
      await device.opened()
      device.send({ t: 'pair', code, name: "Callum's iPad (Safari)" })
      const paired = await device.message('paired')
      expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      await device.message('snapshot')

      await expect(card.getByText("Callum's iPad (Safari)")).toBeVisible()
      await expect(card.getByText('1 device connected now')).toBeVisible()

      // A second device cannot use the same code.
      const reuse = new Device(port)
      await reuse.opened()
      reuse.send({ t: 'pair', code, name: 'Copy' })
      await reuse.message('denied')

      // Reconnecting with the token works; revoking stops it at once.
      const again = new Device(port)
      await again.opened()
      again.send({ t: 'hello', token: paired.token })
      await again.message('snapshot')
      await card.getByRole('button', { name: "Revoke Callum's iPad (Safari)" }).click()
      await expect.poll(() => again.closed).toBe(true)
      await expect(card.getByText('No devices paired yet.')).toBeVisible()

      const revoked = new Device(port)
      await revoked.opened()
      revoked.send({ t: 'hello', token: paired.token })
      await revoked.message('denied')
      for (const d of [wrong, device, reuse, again, revoked]) d.close()
    } finally {
      await cleanup()
    }
  })

  test('the page a phone opens pairs with the code and shows the map', async () => {
    const port = await freePort()
    const { app, window: page, cleanup } = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      const card = await switchOn(page, port)
      await card.getByRole('button', { name: 'Pair a device' }).click()
      const code =
        (await card
          .locator('[aria-label]')
          .filter({ hasText: /^\d{6}$/ })
          .textContent()) ?? ''

      // The real built page, in a hidden window of the same Chromium: nothing is shown or focused.
      const known = app.windows().length
      await app.evaluate(async ({ BrowserWindow }, url) => {
        const window = new BrowserWindow({ show: false })
        await window.loadURL(url)
      }, `http://127.0.0.1:${port}/`)
      await expect.poll(() => app.windows().length).toBeGreaterThan(known)
      const phone = app.windows().find((w) => w.url().startsWith(`http://127.0.0.1:${port}`))!

      await expect(phone.getByRole('heading', { name: 'Pair with WingLog' })).toBeVisible()
      await phone.getByLabel('Pairing code').fill(code === '000000' ? '111111' : '000000')
      await phone.getByRole('button', { name: 'Pair' }).click()
      await expect(phone.getByText("That code didn't work")).toBeVisible()

      await phone.getByLabel('Pairing code').fill(code)
      await phone.getByRole('button', { name: 'Pair' }).click()
      // Paired: no flight is being tracked, so the page says so, over the map.
      await expect(phone.getByText('No flight is being tracked on the PC yet.')).toBeVisible()
      await expect(card.getByText(/Chrome|Electron|Windows PC|Linux PC|Mac|Browser/).first()).toBeVisible()

      // A reload keeps the pairing: the token is remembered, the code is not asked for again.
      await phone.reload()
      await expect(phone.getByText('No flight is being tracked on the PC yet.')).toBeVisible()
    } finally {
      await cleanup()
    }
  })

  test('opening the address a QR code carries pairs the phone without typing, and takes the code out of the address', async () => {
    const port = await freePort()
    const { app, window: page, cleanup } = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      const card = await switchOn(page, port)
      await card.getByRole('button', { name: 'Pair a device' }).click()
      const code =
        (await card
          .locator('[aria-label]')
          .filter({ hasText: /^\d{6}$/ })
          .textContent()) ?? ''

      const known = app.windows().length
      await app.evaluate(async ({ BrowserWindow }, url) => {
        const window = new BrowserWindow({ show: false })
        await window.loadURL(url)
      }, `http://127.0.0.1:${port}/#code=${code}`)
      await expect.poll(() => app.windows().length).toBeGreaterThan(known)
      const phone = app.windows().find((w) => w.url().startsWith(`http://127.0.0.1:${port}`))!

      // Straight to the pages: no code was asked for, and the code is no longer in the address.
      await expect(phone.getByRole('navigation')).toBeVisible()
      await expect(phone.getByLabel('Pairing code')).toHaveCount(0)
      expect(phone.url()).toBe(`http://127.0.0.1:${port}/`)
      await expect(
        card
          .getByText('Phone', { exact: false })
          .or(card.getByText(/Chrome|Electron|Windows PC|Linux PC|Mac|Browser/))
          .first()
      ).toBeVisible()
    } finally {
      await cleanup()
    }
  })

  test("the ground services page shows GSX's gate and service boxes as the app does, from live GSX data", async () => {
    const gsx = await FakeGsxRemoteServer.start()
    const port = await freePort()
    const { app, window: page, cleanup } = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      // GSX Remote and the second screen switched on, then a pairing code, straight through the app's own IPC.
      const code = await page.evaluate(
        async (args) => {
          const api = (globalThis as unknown as Window).winglog
          await api.settingsSetGsxRemote({ enabled: true, host: '127.0.0.1', port: args.gsxPort })
          await api.lanSetSettings({ enabled: true, port: args.port })
          return (await api.lanStartPairing()).pairing?.code ?? ''
        },
        { gsxPort: gsx.port, port }
      )
      expect(code).toMatch(/^\d{6}$/)
      await gsx.waitForConnection()

      const known = app.windows().length
      await app.evaluate(async ({ BrowserWindow }, url) => {
        const window = new BrowserWindow({ show: false, width: 390, height: 780, useContentSize: true })
        await window.loadURL(url)
      }, `http://127.0.0.1:${port}/#code=${code}`)
      await expect.poll(() => app.windows().length).toBeGreaterThan(known)
      const phone = app.windows().find((w) => w.url().startsWith(`http://127.0.0.1:${port}`))!

      gsx.sendSnapshot(VHHH_BOOT_SNAPSHOT)
      await phone.getByRole('navigation').getByRole('button', { name: 'Ground services' }).click()

      // The same gate header, service box and figures the app's own GSX tab shows.
      await expect(phone.getByText('Gate N6')).toBeVisible()
      await expect(phone.getByText('VHHH · Hong Kong Intl · (N) T1 North')).toBeVisible()
      await expect(phone.getByText('Refuel')).toBeVisible()
      await expect(phone.getByText('15,357 / 81,488 kg')).toBeVisible()
      await expect(phone.getByText(/24,272/)).toBeVisible()
      await phone.screenshot({ path: 'release/sim/second-screen/gsx-services.png', animations: 'disabled' })
    } finally {
      await cleanup()
      await gsx.stop()
    }
  })
})
