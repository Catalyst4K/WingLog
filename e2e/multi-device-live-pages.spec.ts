import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { freePort } from './lan-device'
import { FakeGsxRemoteServer } from './gsx-remote-server'
import { ScriptedGsx } from './gsx-routine-session'
import { launchApp } from './launch-app'

// Findings F2, F5 and F6 of winglog-backend's docs/plans/multi-device.md: a page that is open on the client must follow the host's live data
// without the pilot leaving the page and coming back. Two real apps on loopback, as in multi-device-link.spec.ts (needs the multi-device
// build: `npm run test:e2e:multi`).
test('a GSX routine started on the client shows as running on the client page without a page change', async () => {
  const clientDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-client-'))
  const fixture = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')
  const port = await freePort()
  const server = await FakeGsxRemoteServer.start()
  const gsx = new ScriptedGsx(server)
  try {
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
        WINGLOG_E2E_BEYONDATC_PORT: String(await freePort()),
        WINGLOG_E2E_FIXTURE: fixture,
        WINGLOG_E2E_REPLAY_MODE: 'paced',
        WINGLOG_E2E_REPLAY_SPEED: '200'
      }
    })
    try {
      const code = await host.window.evaluate(async (lanPort) => {
        const api = window.winglog
        await api.lanSetSettings({ twinEnabled: true, port: lanPort })
        return (await api.lanStartPairing('twin')).twinPairing?.code ?? ''
      }, port)
      await host.window.evaluate(
        (gsxPort) => window.winglog.settingsSetGsxRemote({ enabled: true, host: '127.0.0.1', port: gsxPort }),
        server.port
      )
      await server.waitForConnection()
      gsx.sendBootSnapshot()

      const client = await launchApp({ userDataDir: clientDir })
      try {
        await client.window.evaluate(([address, pairing]) => window.winglog.hostLinkPair(address, pairing), [
          `127.0.0.1:${port}`,
          code
        ] as const)
        await expect(client.window.getByText('Sim PC: connected')).toBeAttached({ timeout: 15_000 })
        await client.window.getByRole('tab', { name: 'Ground services' }).click()
        await expect(client.window.getByRole('button', { name: 'Departure', exact: true })).toBeEnabled({
          timeout: 15_000
        })

        // F5: press a routine on the client page and stay on it.
        await client.window.getByRole('button', { name: 'Departure', exact: true }).click()
        await expect(client.window.getByTestId('gsx-routine-progress').getByText('Stage 1 of 2')).toBeVisible(
          {
            timeout: 10_000
          }
        )
      } finally {
        await client.cleanup()
      }
    } finally {
      await host.cleanup()
    }
  } finally {
    await server.stop()
    rmSync(clientDir, { recursive: true, force: true })
  }
})
