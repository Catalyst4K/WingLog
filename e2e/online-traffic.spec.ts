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
        await w.settingsSetOnlineNetwork({
          network: 'vatsim',
          vatsimCid: null,
          ivaoVid: null,
          keepBeyondAtcOnline: false,
          simTrafficButton: true
        })
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

  test("the sim's own traffic has its own switch, says when the sim cannot be read, gives way to the network's, and goes when switched off in Settings", async () => {
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
      const code = await page.evaluate(async (p) => {
        const w = (globalThis as unknown as { winglog: Winglog }).winglog
        await w.lanSetSettings({ enabled: true, port: p })
        return (await w.lanStartPairing()).pairing?.code ?? ''
      }, port)
      const phone = new Device(port)
      await phone.opened()
      phone.send({ t: 'pair', code, name: 'Test phone' })
      await phone.message('paired')
      await phone.message('snapshot')
      await expect.poll(() => latestTopic(phone, 'simTraffic')?.state).toBe('off')

      // With no network chosen the sim's button is still there. The test sim is never reachable, so the layer says so.
      await page.getByRole('tab', { name: 'Track' }).click()
      await page.getByRole('button', { name: 'Show sim traffic' }).click()
      await expect(page.getByRole('button', { name: 'Hide sim traffic' })).toBeVisible()
      await expect.poll(() => latestTopic(phone, 'simTraffic')?.state).toBe('unavailable')
      await expect(page.getByText('Sim traffic unavailable')).toBeVisible()

      // The phone turns it off with a command, and the PC follows.
      phone.send({ t: 'cmd', name: 'traffic.setSimOn', args: [false] })
      await expect(page.getByRole('button', { name: 'Show sim traffic' })).toBeVisible()
      await expect(page.getByText('Sim traffic unavailable')).toBeHidden()
      expect(feed.requests).toHaveLength(0)

      // Turn it on, then the network layer: the network's turns the sim's off, and pressing the sim's turns the network's off (Callum,
      // 2026-10-29).
      await page.evaluate(async () => {
        const w = (globalThis as unknown as { winglog: Winglog }).winglog
        await w.settingsSetOnlineNetwork({
          network: 'vatsim',
          vatsimCid: null,
          ivaoVid: null,
          keepBeyondAtcOnline: false,
          simTrafficButton: true
        })
        await w.trafficSetSimOn(true)
        await w.trafficSetNetworkOn(true)
      })
      await expect(page.getByRole('button', { name: 'Hide VATSIM traffic' })).toBeVisible()
      const simButton = page.getByRole('button', { name: 'Show sim traffic' })
      await expect(simButton).toBeEnabled()
      await expect.poll(() => latestTopic(phone, 'simTraffic')?.state).toBe('off')
      await simButton.click()
      await expect(page.getByRole('button', { name: 'Hide sim traffic' })).toBeEnabled()
      await expect(page.getByRole('button', { name: 'Show VATSIM traffic' })).toBeVisible()
      await expect.poll(() => latestTopic(phone, 'trafficLayers')).toMatchObject({ networkOn: false, simOn: true })

      // Its button switched off in Settings: gone from the PC's map, the phone told so, and the layer stops. On again, it is back as its
      // switch was.
      const offerSim = (offered: boolean): Promise<void> =>
        page.evaluate(
          (on) =>
            (globalThis as unknown as { winglog: Winglog }).winglog.settingsSetOnlineNetwork({
              network: 'vatsim',
              vatsimCid: null,
              ivaoVid: null,
              keepBeyondAtcOnline: false,
              simTrafficButton: on
            }),
          offered
        )
      await offerSim(false)
      await expect(page.getByRole('button', { name: /sim traffic/ })).toHaveCount(0)
      await expect
        .poll(() => latestTopic(phone, 'trafficLayers'))
        .toMatchObject({ simOn: true, simOffered: false, drawSim: false })
      await expect.poll(() => latestTopic(phone, 'simTraffic')?.state).toBe('off')
      await expect(page.getByText('Sim traffic unavailable')).toBeHidden()
      await offerSim(true)
      await expect(page.getByRole('button', { name: 'Hide sim traffic' })).toBeEnabled()
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
        await w.settingsSetOnlineNetwork({
          network: 'ivao',
          vatsimCid: null,
          ivaoVid: null,
          keepBeyondAtcOnline: false,
          simTrafficButton: true
        })
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
          ivaoVid: '900099',
          keepBeyondAtcOnline: false,
          simTrafficButton: true
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

  test('with no sim and no flight, the button still shows VATSIM traffic: the whole network', async () => {
    const feed = await startNetworkFeedServer({ centre: EGLL })
    // No replay: WingLog has no aircraft position and no flight to centre on.
    const { window: page, cleanup } = await launchApp({
      env: { WINGLOG_E2E_VATSIM_URL: feed.vatsimUrl, WINGLOG_E2E_IVAO_URL: feed.ivaoUrl }
    })
    try {
      await page.evaluate(() =>
        (globalThis as unknown as { winglog: Winglog }).winglog.settingsSetOnlineNetwork({
          network: 'vatsim',
          vatsimCid: null,
          ivaoVid: null,
          keepBeyondAtcOnline: false,
          simTrafficButton: true
        })
      )
      await page.getByRole('tab', { name: 'Track' }).click()
      await page.getByRole('button', { name: 'Show VATSIM traffic' }).click()
      // Every pilot in the feed, Sydney's included, which the 250 nm around a position would leave out; and no waiting.
      await expect
        .poll(async () => (await traffic(page)).aircraft.map((a) => a.callsign).sort())
        .toEqual(['FAR1', 'NEAR1', 'NEAR2'])
      expect((await traffic(page)).state).toBe('shown')
      expect(feed.requests.every((r) => r.path.startsWith('/vatsim'))).toBe(true)
      await expect(page.getByText(/traffic unavailable/)).toBeHidden()
    } finally {
      await cleanup()
      await feed.close()
    }
  })

  test('with no sim and no flight, IVAO shows the whole network too, but only once its VID is entered', async () => {
    const feed = await startNetworkFeedServer({ centre: EGLL })
    const { window: page, cleanup } = await launchApp({
      env: { WINGLOG_E2E_VATSIM_URL: feed.vatsimUrl, WINGLOG_E2E_IVAO_URL: feed.ivaoUrl }
    })
    const chooseIvao = (vid: string | null): Promise<void> =>
      page.evaluate(
        (ivaoVid) =>
          (globalThis as unknown as { winglog: Winglog }).winglog.settingsSetOnlineNetwork({
            network: 'ivao',
            vatsimCid: null,
            ivaoVid,
            keepBeyondAtcOnline: false,
            simTrafficButton: true
          }),
        vid
      )
    try {
      await chooseIvao(null)
      await page.evaluate(() =>
        (globalThis as unknown as { winglog: Winglog }).winglog.trafficSetNetworkOn(true)
      )
      await expect.poll(async () => (await traffic(page)).state).toBe('needsVid')
      await page.waitForTimeout(1500)
      expect(feed.requests).toHaveLength(0)

      await chooseIvao('900099')
      await expect
        .poll(async () => (await traffic(page)).aircraft.map((a) => a.callsign).sort(), { timeout: 20_000 })
        .toEqual(['FAR1', 'NEAR1'])
      expect(feed.requests.every((r) => r.path === '/ivao')).toBe(true)
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
        .toEqual({
          network: 'vatsim',
          vatsimCid: '1234567',
          ivaoVid: null,
          keepBeyondAtcOnline: false,
          simTrafficButton: true
        })
    } finally {
      await cleanup()
    }
  })
})
