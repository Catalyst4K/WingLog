import { expect, test } from '@playwright/test'
import { Device, freePort, openPhoneCode, switchPhonesOn } from './lan-device'
import { launchApp } from './launch-app'

/**
 * Settings → Devices (winglog-backend's docs/plans/devices-page.md) through a real launched app: phones switched on, the page the server
 * serves, Add a device for a phone with the code the PC shows, the new device in the list as Connected, renaming it, and removing it
 * after the confirmation. The server listens on loopback here (the app's WINGLOG_E2E_LAN_ADDRESS, honoured by an unpackaged build only),
 * so no real network or firewall is touched.
 */

test.describe('Devices', () => {
  test('pairs a phone from Add a device, lists it as connected, renames it and removes it', async () => {
    const port = await freePort()
    const { window: page, cleanup } = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: /^Devices/ }).click()
      await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible()
      await expect(page.getByText('Nothing paired yet.')).toBeVisible()
      await expect(
        page
          .getByRole('group', { name: 'Phones and tablets' })
          .getByRole('button', { name: 'Off', exact: true })
      ).toHaveAttribute('aria-pressed', 'true')

      await switchPhonesOn(page, port)

      // The page itself carries no data, and anything else is not found.
      const html = await fetch(`http://127.0.0.1:${port}/`)
      expect(html.status).toBe(200)
      expect(await html.text()).toContain('<div id="root">')
      expect((await fetch(`http://127.0.0.1:${port}/etc/passwd`)).status).toBe(404)

      const { dialog, code } = await openPhoneCode(page)
      expect(code).toMatch(/^\d{6}$/)
      const qr = dialog.getByRole('img', { name: 'QR code for the second-screen address' })
      await expect(qr).toBeVisible()
      expect(await qr.locator('path').getAttribute('d')).toMatch(/^M\d+ \d+h\d+v1/)
      await expect(dialog.getByText('Waiting for the device')).toBeVisible()

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

      // The dialog moves to its success step, and Done closes it.
      await expect(dialog.getByText("Callum's iPad (Safari) is paired")).toBeVisible()
      await dialog.getByRole('button', { name: 'Done' }).click()
      await expect(dialog).toHaveCount(0)

      // In the list, connected now.
      await expect(page.getByText("Callum's iPad (Safari)")).toBeVisible()
      await expect(page.getByText('Connected', { exact: true })).toBeVisible()
      await expect(page.getByRole('tab', { name: /^Devices/ })).toContainText('1 connected')

      // A second device cannot use the same code.
      const reuse = new Device(port)
      await reuse.opened()
      reuse.send({ t: 'pair', code, name: 'Copy' })
      await reuse.message('denied')

      // Renamed in the list: the new name is what the PC keeps.
      await page.getByRole('button', { name: "Rename Callum's iPad (Safari)" }).click()
      const name = page.getByRole('textbox', { name: 'Name' })
      await name.fill('Kitchen iPad')
      await name.press('Enter')
      await expect(page.getByText('Kitchen iPad')).toBeVisible()
      await expect
        .poll(async () =>
          (await page.evaluate(() => window.winglog.lanGetStatus())).devices.map((d) => d.name)
        )
        .toEqual(['Kitchen iPad'])

      // Remove asks first; Cancel keeps it, Remove stops its token at once.
      await page.getByRole('button', { name: 'Remove Kitchen iPad' }).click()
      const confirm = page.getByRole('alertdialog')
      await expect(confirm.getByText('Remove Kitchen iPad?')).toBeVisible()
      await confirm.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByText('Kitchen iPad')).toBeVisible()
      expect(device.closed).toBe(false)
      await page.getByRole('button', { name: 'Remove Kitchen iPad' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click()
      await expect.poll(() => device.closed).toBe(true)
      await expect(page.getByText('Nothing paired yet.')).toBeVisible()

      const revoked = new Device(port)
      await revoked.opened()
      revoked.send({ t: 'hello', token: paired.token })
      await revoked.message('denied')
      for (const d of [wrong, device, reuse, revoked]) d.close()
    } finally {
      await cleanup()
    }
  })
})
