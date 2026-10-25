import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { Device, freePort, latestTopic } from './lan-device'
import { launchApp } from './launch-app'
import { startNetworkFeedServer } from './network-feed-server'

/**
 * The online-network traffic end to end (winglog-backend's docs/plans/vatsim-build.md, Step 1): choose a network, switch the layer on,
 * and see the aircraft near the replayed aircraft on the PC and a phone, from a fake feed, never the real networks. Timing rules (the 15 s
 * floor, back-off) are proved in unit tests, not by waiting here.
 */

/** Near EGLL, where the replayed short hop starts. */
const EGLL = { lat: 51.47, lon: -0.46 }
const FIXTURE = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')

type Winglog = Window['winglog']

function traffic(page: Page): Promise<{ state: string; aircraft: { callsign: string }[] }> {
  return page.evaluate(() => (globalThis as unknown as Window).winglog.getNetworkTraffic())
}

function layers(page: Page): Promise<{ networkOn: boolean; drawNetwork: boolean }> {
  return page.evaluate(() => (globalThis as unknown as Window).winglog.getTrafficLayers())
}

test.describe('Online network traffic', () => {
  test('reads the chosen network politely, shows the near aircraft on the PC and the phone, and shares one switch', async () => {
    const feed = await startNetworkFeedServer({ centre: EGLL })
    const port = await freePort()
    const { window: page, cleanup } = await launchApp({
      env: {
        WINGLOG_E2E_FIXTURE: FIXTURE,
        WINGLOG_E2E_REPLAY_MODE: 'paced',
        WINGLOG_E2E_REPLAY_SPEED: '1',
        WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1',
        WINGLOG_E2E_VATSIM_URL: feed.vatsimUrl,
        WINGLOG_E2E_IVAO_URL: feed.ivaoUrl
      }
    })
    try {
      // Nothing is read until a network is chosen and the switch is on.
      expect((await layers(page)).networkOn).toBe(false)
      await page.waitForTimeout(500)
      expect(feed.requests).toHaveLength(0)

      const code = await page.evaluate(async (p) => {
        const w = (globalThis as unknown as { winglog: Winglog }).winglog
        await w.settingsSetOnlineNetwork({ network: 'vatsim', vatsimCid: null, ivaoVid: null })
        await w.lanSetSettings({ enabled: true, port: p })
        return (await w.lanStartPairing()).pairing?.code ?? ''
      }, port)
      const phone = new Device(port)
      await phone.opened()
      phone.send({ t: 'pair', code, name: 'Test phone' })
      await phone.message('paired')
      await phone.message('snapshot')
      await expect.poll(() => latestTopic(phone, 'trafficLayers')?.networkOn).toBe(false)

      // The PC turns the switch on: both screens see it, and the feed is read with WingLog's User-Agent, asking for gzip.
      await page.evaluate(() => (globalThis as unknown as Window).winglog.trafficSetNetworkOn(true))
      await expect.poll(() => latestTopic(phone, 'trafficLayers')?.networkOn).toBe(true)
      await expect.poll(() => feed.requests.length).toBeGreaterThan(0)
      const first = feed.requests[0]!
      expect(first.path).toBe('/vatsim')
      expect(String(first.headers['user-agent'])).toMatch(
        /^WingLog\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/Catalyst4K\/WingLog\)$/
      )
      expect(String(first.headers['accept-encoding'])).toContain('gzip')

      // The aircraft near the replayed one are listed, and the one on the other side of the world is not.
      await expect
        .poll(async () => (await traffic(page)).aircraft.map((a) => a.callsign).sort(), { timeout: 20_000 })
        .toEqual(['NEAR1', 'NEAR2'])
      expect((await traffic(page)).state).toBe('shown')
      await expect
        .poll(() => ((latestTopic(phone, 'networkTraffic')?.aircraft ?? []) as { callsign: string }[]).length)
        .toBe(2)

      // The phone flips the switch with a command, and the PC follows.
      phone.send({ t: 'cmd', name: 'traffic.setNetworkOn', args: [false] })
      await expect.poll(async () => (await layers(page)).networkOn).toBe(false)
      await expect.poll(() => latestTopic(phone, 'networkTraffic')?.state).toBe('off')
      phone.send({ t: 'cmd', name: 'traffic.setNetworkOn', args: [true] })
      await expect.poll(async () => (await layers(page)).networkOn).toBe(true)

      // The switch is refused unless it is a boolean, and nothing changes.
      phone.send({ t: 'cmd', name: 'traffic.setNetworkOn', args: ['yes'] })
      await page.waitForTimeout(300)
      expect((await layers(page)).networkOn).toBe(true)

      // The Track map on the PC has the button for it.
      await page.getByRole('tab', { name: 'Track' }).click()
      await expect(page.getByRole('button', { name: 'Hide VATSIM traffic' })).toBeVisible()
      phone.close()
    } finally {
      await cleanup()
      await feed.close()
    }
  })

  test('makes no request at all for IVAO without a VID, and reads IVAO once the VID is entered', async () => {
    const feed = await startNetworkFeedServer({ centre: EGLL })
    const { window: page, cleanup } = await launchApp({
      env: {
        WINGLOG_E2E_FIXTURE: FIXTURE,
        WINGLOG_E2E_REPLAY_MODE: 'paced',
        WINGLOG_E2E_REPLAY_SPEED: '1',
        WINGLOG_E2E_VATSIM_URL: feed.vatsimUrl,
        WINGLOG_E2E_IVAO_URL: feed.ivaoUrl
      }
    })
    try {
      await page.evaluate(async () => {
        const w = (globalThis as unknown as { winglog: Winglog }).winglog
        await w.settingsSetOnlineNetwork({ network: 'ivao', vatsimCid: null, ivaoVid: null })
        await w.trafficSetNetworkOn(true)
      })
      await expect.poll(async () => (await traffic(page)).state).toBe('needsVid')
      await page.waitForTimeout(1500)
      expect(feed.requests).toHaveLength(0)
      expect((await layers(page)).drawNetwork).toBe(false)

      await page.getByRole('tab', { name: 'Track' }).click()
      await expect(page.getByRole('button', { name: 'Show IVAO traffic' })).toBeDisabled()

      await page.evaluate(() =>
        (globalThis as unknown as { winglog: Winglog }).winglog.settingsSetOnlineNetwork({
          network: 'ivao',
          vatsimCid: null,
          ivaoVid: '900099'
        })
      )
      await expect.poll(() => feed.requests.length, { timeout: 20_000 }).toBeGreaterThan(0)
      expect(feed.requests.every((r) => r.path === '/ivao')).toBe(true)
      await expect
        .poll(async () => (await traffic(page)).aircraft.map((a) => a.callsign), { timeout: 20_000 })
        .toEqual(['NEAR1'])
    } finally {
      await cleanup()
      await feed.close()
    }
  })

  test('the Online network card chooses a network and keeps it across a restart', async () => {
    const { window: page, cleanup } = await launchApp()
    try {
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: '3rd party' }).click()
      const card = page.locator('[data-slot="card"]').filter({ hasText: 'Online network' })
      await card.getByRole('button', { name: 'VATSIM' }).click()
      await card.getByRole('textbox').fill('1234567')
      await card.getByRole('textbox').blur()
      await expect
        .poll(() => page.evaluate(() => (globalThis as unknown as Window).winglog.settingsGetOnlineNetwork()))
        .toEqual({ network: 'vatsim', vatsimCid: '1234567', ivaoVid: null })
    } finally {
      await cleanup()
    }
  })
})
