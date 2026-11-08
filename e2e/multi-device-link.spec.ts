import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { freePort } from './lan-device'
import { launchApp } from './launch-app'

// Part 2 of winglog-backend's docs/plans/multi-device.md, through two real launched apps on loopback: a host replaying a recorded flight and
// serving its second screen, and a client that pairs with it and follows its live data. Needs a build with the multi-device flag
// (`npm run test:e2e:multi`); in a release-style build the run mode cannot be chosen and the test skips itself.
test('a client pairs with the host by address and code, follows its sim and keeps the link across a restart', async () => {
  const clientDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-client-'))
  const fixture = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')
  const port = await freePort()
  try {
    // The client's first launch only chooses the client run mode, which applies from the next launch.
    const setup = await launchApp({ userDataDir: clientDir })
    try {
      const capabilities = await setup.window.evaluate(() => window.winglog.appGetCapabilities())
      test.skip(!capabilities.multiDevice, 'needs a build with WINGLOG_MULTI_DEVICE=1')
      await setup.window.evaluate(() => window.winglog.settingsSetRunMode('client'))
    } finally {
      await setup.cleanup()
    }

    const host = await launchApp({
      env: {
        WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1',
        WINGLOG_E2E_FIXTURE: fixture,
        WINGLOG_E2E_REPLAY_MODE: 'paced',
        WINGLOG_E2E_REPLAY_SPEED: '200'
      }
    })
    try {
      const code = await host.window.evaluate(async (lanPort) => {
        const api = window.winglog
        await api.lanSetSettings({ enabled: true, port: lanPort })
        return (await api.lanStartPairing()).pairing?.code ?? ''
      }, port)
      expect(code).toMatch(/^\d{6}$/)

      // BeyondATC is switched on at the host: its tab follows on the client once it is connected.
      await host.window.evaluate(() =>
        window.winglog.settingsSetBeyondAtc({ enabled: true, host: '127.0.0.1' })
      )

      const client = await launchApp({ userDataDir: clientDir })
      try {
        await expect(client.window.getByText('Sim PC: not paired')).toBeVisible()
        // An address that is not on the home network is refused, and nothing is opened.
        await expect(
          client.window.evaluate(() => window.winglog.hostLinkPair('example.com:5051', '123456'))
        ).rejects.toThrow()

        await client.window.evaluate(([address, pairing]) => window.winglog.hostLinkPair(address, pairing), [
          `127.0.0.1:${port}`,
          code
        ] as const)
        await expect(client.window.getByText('Sim PC: connected')).toBeVisible({ timeout: 15_000 })
        await expect(client.window.getByRole('tab', { name: 'BeyondATC' })).toBeVisible({ timeout: 15_000 })
        expect(await client.window.evaluate(() => window.winglog.hostLinkGetStatus())).toMatchObject({
          state: 'connected',
          address: `127.0.0.1:${port}`
        })
        // The host's replayed sim reaches the client's own hub, and so its screens: the client has no sim of its own.
        await expect
          .poll(
            () =>
              client.window.evaluate(async () => {
                const status = await window.winglog.getSimConnectionStatus()
                return status.state === 'connected' ? status.simConnectVersion : status.state
              }),
            { timeout: 15_000 }
          )
          .toBe('replay')
        // The host lists the client as a paired device.
        const devices = await host.window.evaluate(async () => (await window.winglog.lanGetStatus()).devices)
        expect(devices).toHaveLength(1)
        expect(devices[0]?.name).toContain('WingLog on')
      } finally {
        await client.cleanup()
      }

      // A restart: the token and address are remembered, so it reconnects without a code.
      const again = await launchApp({ userDataDir: clientDir })
      try {
        await expect(again.window.getByText('Sim PC: connected')).toBeVisible({ timeout: 20_000 })
        await again.window.evaluate(() => window.winglog.hostLinkForget())
        await expect(again.window.getByText('Sim PC: not paired')).toBeVisible()
      } finally {
        await again.cleanup()
      }
    } finally {
      await host.cleanup()
    }
  } finally {
    rmSync(clientDir, { recursive: true, force: true })
  }
})
