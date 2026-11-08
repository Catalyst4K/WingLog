import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp } from './launch-app'

// Part 1 of winglog-backend's docs/plans/multi-device.md: a client starts none of the host's services. Needs a build with the multi-device
// flag (`npm run test:e2e:multi`); in a release-style build the run mode cannot be chosen and the test skips itself.
test('a client starts none of the host services and offers none of their settings, and the host comes back', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-runmode-'))
  try {
    const first = await launchApp({ userDataDir })
    try {
      const capabilities = await first.window.evaluate(() => window.winglog.appGetCapabilities())
      test.skip(!capabilities.multiDevice, 'needs a build with WINGLOG_MULTI_DEVICE=1')
      expect(capabilities.runMode).toBe('host')
      // The host answers its own services' channels for real.
      expect(await first.window.evaluate(() => window.winglog.lanGetStatus())).toMatchObject({
        listening: false
      })
      await first.window.evaluate(() => window.winglog.settingsSetRunMode('client'))
      // The choice applies at the next launch, not to this run.
      expect((await first.window.evaluate(() => window.winglog.appGetCapabilities())).runMode).toBe('host')
    } finally {
      await first.cleanup()
    }

    const client = await launchApp({ userDataDir })
    try {
      const capabilities = await client.window.evaluate(() => window.winglog.appGetCapabilities())
      expect(capabilities).toMatchObject({ runMode: 'client', multiDevice: true })
      await expect(client.window.getByText('Sim PC: not connected')).toBeVisible()
      await expect(client.window.getByText(/SimConnect:/)).toHaveCount(0)
      // Nothing started the second screen: its channel is answered with nothing, not a status.
      expect(await client.window.evaluate(() => window.winglog.lanGetStatus())).toBeUndefined()
      expect(await client.window.evaluate(() => window.winglog.settingsGetGsxRemote())).toMatchObject({
        enabled: false
      })
      await client.window.getByRole('tab', { name: 'Settings' }).click()
      await client.window.getByRole('tab', { name: '3rd party' }).click()
      await expect(client.window.getByText('Credentials')).toBeVisible()
      await expect(client.window.getByText('GSX ground services')).toHaveCount(0)
      await expect(client.window.getByText('BeyondATC')).toHaveCount(0)
      await expect(client.window.getByText('Online network')).toHaveCount(0)
      await client.window.getByRole('tab', { name: 'Data' }).click()
      await expect(client.window.getByText('Where the sim runs')).toBeVisible()
      await expect(client.window.getByText('Second screen')).toHaveCount(0)
      // Fleet, Logbook and Dispatch are the client's own and work as ever.
      await client.window.getByRole('tab', { name: 'Fleet' }).click()
      await expect(client.window.getByRole('heading', { name: 'Fleet' })).toBeVisible()
      await client.window.evaluate(() => window.winglog.settingsSetRunMode('host'))
    } finally {
      await client.cleanup()
    }

    const host = await launchApp({ userDataDir })
    try {
      expect((await host.window.evaluate(() => window.winglog.appGetCapabilities())).runMode).toBe('host')
      await expect(host.window.getByText(/SimConnect:/)).toBeVisible()
      expect(await host.window.evaluate(() => window.winglog.lanGetStatus())).toMatchObject({
        listening: false
      })
    } finally {
      await host.cleanup()
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
