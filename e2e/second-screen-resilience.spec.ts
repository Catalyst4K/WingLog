import { expect, test } from '@playwright/test'
import { freePort, openPhone } from './lan-device'
import { launchApp } from './launch-app'

/**
 * The phone page keeps up with the PC (winglog-backend's docs/plans/lan-web-viewer.md): when the PC stops serving it says so and
 * comes back by itself when the PC serves again, a device the pilot revokes is sent back to the pairing screen, and a device that
 * was never paired is asked for a code. A hidden window of the app's Chromium stands in for the phone, over loopback.
 */

test.describe('Second screen: the phone page through changes on the PC', () => {
  test('says it cannot reach the PC when the second screen is switched off, and reconnects by itself when it is back on', async () => {
    const port = await freePort()
    const { app, window: pc, cleanup } = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      const code = await pc.evaluate(async (p) => {
        const api = (globalThis as unknown as Window).winglog
        await api.lanSetSettings({ enabled: true, port: p })
        return (await api.lanStartPairing()).pairing?.code ?? ''
      }, port)
      const phone = await openPhone(app, `http://127.0.0.1:${port}/#code=${code}`)
      await expect(phone.getByRole('navigation')).toBeVisible()
      await expect(phone.getByText("Can't reach the PC. Trying again…")).toHaveCount(0)

      await pc.evaluate(
        (p) => (globalThis as unknown as Window).winglog.lanSetSettings({ enabled: false, port: p }),
        port
      )
      await expect(phone.getByText("Can't reach the PC. Trying again…")).toBeVisible({ timeout: 45_000 })

      await pc.evaluate(
        (p) => (globalThis as unknown as Window).winglog.lanSetSettings({ enabled: true, port: p }),
        port
      )
      await expect(phone.getByText("Can't reach the PC. Trying again…")).toHaveCount(0, { timeout: 60_000 })
      await expect(phone.getByRole('navigation')).toBeVisible()
    } finally {
      await cleanup()
    }
  })

  test('a device the pilot revokes is sent back to the pairing screen and cannot get in again with its old token', async () => {
    const port = await freePort()
    const { app, window: pc, cleanup } = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      const code = await pc.evaluate(async (p) => {
        const api = (globalThis as unknown as Window).winglog
        await api.lanSetSettings({ enabled: true, port: p })
        return (await api.lanStartPairing()).pairing?.code ?? ''
      }, port)
      const phone = await openPhone(app, `http://127.0.0.1:${port}/#code=${code}`)
      await expect(phone.getByRole('navigation')).toBeVisible()

      await pc.evaluate(async () => {
        const api = (globalThis as unknown as Window).winglog
        const status = await api.lanGetStatus()
        for (const device of status.devices) await api.lanRevokeDevice(device.id)
      })
      await expect(phone.getByRole('heading', { name: 'Pair with WingLog' })).toBeVisible({ timeout: 45_000 })

      await phone.reload()
      await expect(phone.getByRole('heading', { name: 'Pair with WingLog' })).toBeVisible()
      await expect(phone.getByRole('navigation')).toHaveCount(0)
    } finally {
      await cleanup()
    }
  })

  test('a device that was never paired is asked for a code, and the page shows no flight data', async () => {
    const port = await freePort()
    const { app, window: pc, cleanup } = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      await pc.evaluate(
        (p) => (globalThis as unknown as Window).winglog.lanSetSettings({ enabled: true, port: p }),
        port
      )
      const phone = await openPhone(app, `http://127.0.0.1:${port}/`)
      await expect(phone.getByRole('heading', { name: 'Pair with WingLog' })).toBeVisible()
      await expect(phone.getByLabel('Pairing code')).toBeVisible()
      await expect(phone.getByRole('navigation')).toHaveCount(0)
    } finally {
      await cleanup()
    }
  })
})
