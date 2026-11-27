import { createServer } from 'node:net'
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { WebSocket } from 'ws'

/** What the device specs share: a free loopback port, a device that talks to the PC the way the phone page does, and the Devices page's steps. */

/** A port nothing listens on. */
export function freePort(): Promise<number> {
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
export class Device {
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
 * @param device A device.
 * @param name A live topic's name.
 * @returns The topic's payload as the device was last sent it, from its snapshot or a later push; null when it was sent none or a null.
 */
export function latestTopic(device: Device, name: string): Record<string, unknown> | null {
  let latest: Record<string, unknown> | null = null
  for (const message of device.received) {
    if (message.t === 'snapshot') {
      const topics = message.topics as Record<string, unknown> | undefined
      if (topics && name in topics) latest = topics[name] as Record<string, unknown> | null
    } else if (message.t === 'topic' && message.name === name) {
      latest = message.payload as Record<string, unknown> | null
    }
  }
  return latest
}

/**
 * Opens the page in a hidden window.
 *
 * @param app The app.
 * @param url The address, with a pairing code in it when the device should pair itself.
 * @returns The page.
 */
export async function openPhone(app: ElectronApplication, url: string): Promise<Page> {
  const known = app.windows().length
  await app.evaluate(async ({ BrowserWindow }, address) => {
    const window = new BrowserWindow({ show: false, width: 390, height: 780, useContentSize: true })
    await window.loadURL(address)
  }, url)
  await expect.poll(() => app.windows().length).toBeGreaterThan(known)
  const origin = new URL(url).origin
  return app.windows().find((w) => w.url().startsWith(origin))!
}

/**
 * Opens Settings → Devices and switches phones and tablets on, on the port given.
 *
 * @param page The app window.
 * @param port The port to listen on.
 * @param host The address the server listens on (loopback in the specs).
 */
export async function switchPhonesOn(page: Page, port: number, host = '127.0.0.1'): Promise<void> {
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByRole('tab', { name: /^Devices/ }).click()
  await page
    .getByRole('group', { name: 'Phones and tablets' })
    .getByRole('button', { name: 'On', exact: true })
    .click()
  const portBox = page.getByRole('textbox', { name: 'Port' })
  await portBox.fill(String(port))
  await portBox.blur()
  await expect(page.getByText(`http://${host}:${port}/`)).toBeVisible()
}

/**
 * On Settings → Devices, opens Add a device for a phone or tablet and reads the code it shows.
 *
 * @param page The app window.
 * @returns The dialog, and the 6-digit code.
 */
export async function openPhoneCode(page: Page): Promise<{ dialog: Locator; code: string }> {
  await page.getByRole('button', { name: 'Add a device' }).click()
  const dialog = page.getByRole('dialog')
  // A multi-device build asks which kind first; one without opens on the phone's code.
  const choice = dialog.getByRole('button', { name: /A phone or tablet/ })
  const phoneStep = dialog.getByRole('heading', { name: 'Pair a phone or tablet' })
  await choice.or(phoneStep).first().waitFor()
  if (await choice.isVisible()) await choice.click()
  const codeLocator = dialog.locator('[aria-label]').filter({ hasText: /^\d{6}$/ })
  await codeLocator.waitFor()
  return { dialog, code: (await codeLocator.textContent()) ?? '' }
}
