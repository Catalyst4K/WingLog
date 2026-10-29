/**
 * THROWAWAY (not committed): a copy of the built app, left open for Callum to try "are you online" without connecting to VATSIM or IVAO.
 * A fake feed for each network holds an invented pilot (member number 1234567: DEMO123 on VATSIM, IVDEMO1 on IVAO) at the replayed
 * flight's position, plus VHHH controllers and an ATIS that differ per network, and a stand-in BeyondATC with auto-tune on. Both the CID
 * and the VID are filled in, so switching network in Settings switches feed. Create DEMO-OFFLINE.flag in release/sim/ to take the pilot
 * out of both feeds, delete it to put it back.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { FakeBeyondAtcServer } from './beyondatc-server'
import { launchApp } from './launch-app'
import { ivaoBody, vatsimBody, type FeedScene } from './network-feed-server'

const VHHH_HOP = join(process.cwd(), 'src/main/tracking/__fixtures__/tier2-vfr-no-ofp-short-hop.ndjson')
const FLAG = join(process.cwd(), 'release', 'sim', 'DEMO-OFFLINE.flag')
const MEMBER = 1234567
type Winglog = Window['winglog']

/**
 * @param scene The demo scene.
 * @returns The shared fake IVAO feed, plus the pilot as IVDEMO1 and IVAO's own VHHH ground, tower and ATIS.
 */
function demoIvaoBody(scene: FeedScene): string {
  const feed = JSON.parse(ivaoBody(scene)) as { clients: { pilots: object[]; atcs: object[] } }
  if (scene.self) {
    feed.clients.pilots.push({
      id: 99,
      userId: scene.self.cid,
      callsign: 'IVDEMO1',
      lastTrack: {
        latitude: scene.centre.lat,
        longitude: scene.centre.lon,
        altitude: 80,
        groundSpeed: 0,
        heading: 70,
        onGround: true,
        timestamp: new Date().toISOString()
      },
      flightPlan: { departureId: 'VHHH', arrivalId: 'VHHH', aircraftId: 'C172' }
    })
  }
  // The controllers, with their own ATIS, come from the shared fake feed (network-feed-server.ts).
  return JSON.stringify(feed)
}

test('the online demo', async () => {
  test.setTimeout(0)
  mkdirSync(join(process.cwd(), 'release', 'sim'), { recursive: true })
  const scene: FeedScene = {
    centre: { lat: 22.31, lon: 113.92 },
    self: { cid: MEMBER, callsign: 'DEMO123' },
    station: 'VHHH',
    // Heathrow's split ATIS (try Dispatch's weather card, Custom tab, EGLL), and invented controllers over London and Hong Kong for the
    // ATC button on the Track map.
    splitStation: 'EGLL',
    coverage: true,
    extraControllers: [
      { callsign: 'HKG_CTR', frequency: '132.200', facility: 6 },
      { callsign: 'VHHH_APP', frequency: '119.100', facility: 5 },
      { callsign: 'VHHH_GND', frequency: '121.600', facility: 3 },
      { callsign: 'VHHH_DEL', frequency: '121.950', facility: 2 },
      { callsign: 'EGKK_APP', frequency: '126.825', facility: 5 },
      { callsign: 'EGKK_TWR', frequency: '124.225', facility: 4 }
    ]
  }
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(req.url === '/ivao' ? demoIvaoBody(scene) : vatsimBody(scene))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const beyondAtc = await FakeBeyondAtcServer.start()
  const { window: page, cleanup } = await launchApp({
    env: {
      // For a person, not a test: a normal window on the real GPU. The test default (software GL, shown without focus) left it blank.
      WINGLOG_E2E_WINDOW: 'normal',
      WINGLOG_E2E_SOFTWARE_GL: '',
      WINGLOG_E2E_FIXTURE: VHHH_HOP,
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: '1',
      WINGLOG_E2E_REPLAY_HOLD: '1',
      WINGLOG_E2E_VATSIM_URL: `http://127.0.0.1:${port}/vatsim`,
      WINGLOG_E2E_IVAO_URL: `http://127.0.0.1:${port}/ivao`,
      ...beyondAtc.env
    }
  })
  // The flag file takes the invented pilot out of both feeds, and back.
  const poll = setInterval(() => {
    const wantOffline = existsSync(FLAG)
    if (wantOffline && scene.self) delete scene.self
    if (!wantOffline && !scene.self) scene.self = { cid: MEMBER, callsign: 'DEMO123' }
  }, 1000)
  try {
    await page.getByRole('tab', { name: 'Settings' }).click()
    await page.getByRole('tab', { name: '3rd party' }).click()
    const card = page
      .locator('[data-slot="card"]')
      .filter({ hasText: 'BeyondATC' })
      .filter({ has: page.getByLabel('Host') })
    await card.getByLabel('Host').fill('127.0.0.1')
    await card.getByRole('button', { name: 'On', exact: true }).click()
    await beyondAtc.waitForConnection()
    await page.evaluate(
      (member) =>
        (globalThis as unknown as { winglog: Winglog }).winglog.settingsSetOnlineNetwork({
          network: 'vatsim',
          vatsimCid: member,
          ivaoVid: member,
          keepBeyondAtcOnline: false,
          simTrafficButton: true
        }),
      String(MEMBER)
    )
    await page.getByRole('tab', { name: 'Track' }).click()
    await page.getByRole('button', { name: 'Free flight' }).click()
    await page.getByRole('button', { name: 'Start tracking' }).click()
    await expect(page.getByTitle('Online on VATSIM as DEMO123.')).toBeVisible({ timeout: 30_000 })
    beyondAtc.sendLines('AutoTune: false')
    console.log(
      'DEMO READY: online as DEMO123 (VATSIM) / IVDEMO1 (IVAO), BeyondATC connected with auto-tune off'
    )
    await page.waitForEvent('close', { timeout: 0 })
  } finally {
    clearInterval(poll)
    await cleanup().catch(() => undefined)
    await beyondAtc.stop().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
