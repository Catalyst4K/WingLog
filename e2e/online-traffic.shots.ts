/**
 * The online networks as Callum would see them (winglog-backend docs/plans/vatsim-build.md, Steps 1 to 5 and 4b): the built app replays a
 * flight, a fake VATSIM feed puts invented aircraft and an invented tower and ATIS nearby, and pictures are taken of the Track page with each
 * traffic button in each state, IVAO without a VID, and a tracked flight flown "online" (the BeyondATC note, the controllers card, the
 * runway suggestion, and the warning while BeyondATC's auto-tune is on). Writes release/sim/online-traffic/ (gitignored) with an index.html
 * to look through.
 * Run with `npm run sim:online-traffic` (builds first); needs BeyondATC and WingLog closed. No real network is read: the feed is a local
 * server of invented aircraft, BeyondATC is a local stand-in, and the sim is never reachable (so the teal layer shows its "unavailable" pill,
 * not aircraft: that part is checked by eye in a real flight with BeyondATC running).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { FakeBeyondAtcServer } from './beyondatc-server'
import { launchApp } from './launch-app'
import { startNetworkFeedServer } from './network-feed-server'

const OUT = join(process.cwd(), 'release', 'sim', 'online-traffic')
const EGLL_HOP = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')
const VHHH_HOP = join(process.cwd(), 'src/main/tracking/__fixtures__/tier2-vfr-no-ofp-short-hop.ndjson')
const EGLL = { lat: 51.47, lon: -0.46 }
const VHHH = { lat: 22.31, lon: 113.92 }

type Winglog = Window['winglog']

interface Shot {
  file: string
  title: string
  note: string
}

/** Every picture taken, in order, for the page written at the end. */
const shots: Shot[] = []

async function snap(target: Page | Locator, shot: Shot): Promise<void> {
  await target.screenshot({ path: join(OUT, shot.file), animations: 'disabled' })
  shots.push(shot)
}

function report(): string {
  const figures = shots
    .map(
      (s) =>
        `<figure><img src="${s.file}" alt="${s.title}"><figcaption><strong>${s.title}</strong><br>${s.note}</figcaption></figure>`
    )
    .join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Online traffic check</title>
<style>body{font:15px system-ui;margin:0 auto;max-width:1100px;padding:16px;background:#fafafa;color:#111}
figure{margin:0 0 28px}img{max-width:100%;border:1px solid #ccc;border-radius:8px}figcaption{margin-top:6px}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}img{border-color:#444}}</style></head><body>
<h1>Online networks: what to look at</h1>
<p>Amber aircraft are the network's (invented, from a local feed). The sim's own aircraft are teal; they need a real flight with BeyondATC running.
Look for: the two traffic buttons at the top right and their states, the pills at the top left never covering each other, the ground aircraft smaller
and dimmer, and on the tracked flight the BeyondATC note, the controllers card (it scrolls rather than pushing the map off the page), the runway
suggestion above the ATIS text, and the amber auto-tune warning on Track and above the BeyondATC page's toggles.</p>
${figures}</body></html>`
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }))
test.afterAll(() => writeFileSync(join(OUT, 'index.html'), report()))

test('the traffic layers, their buttons and what they say', async () => {
  const feed = await startNetworkFeedServer({ centre: EGLL })
  const { window: page, cleanup } = await launchApp({
    env: {
      WINGLOG_E2E_FIXTURE: EGLL_HOP,
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: '1',
      WINGLOG_E2E_VATSIM_URL: feed.vatsimUrl,
      WINGLOG_E2E_IVAO_URL: feed.ivaoUrl
    }
  })
  try {
    await page.setViewportSize({ width: 1200, height: 800 }).catch(() => undefined)
    await page.getByRole('tab', { name: 'Track' }).click()
    await page.waitForTimeout(3000)
    await snap(page, {
      file: '1-off.png',
      title: 'Both layers off',
      note: 'No network chosen: only the sim traffic button (the aeroplane taking off) is offered.'
    })

    await page.evaluate(async () => {
      const w = (globalThis as unknown as { winglog: Winglog }).winglog
      await w.settingsSetOnlineNetwork({
        network: 'ivao',
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false
      })
      await w.trafficSetNetworkOn(true)
    })
    await expect(page.getByRole('button', { name: 'Show IVAO traffic' })).toBeDisabled()
    await snap(page, {
      file: '2-ivao-no-vid.png',
      title: 'IVAO chosen without a VID',
      note: 'The IVAO button is greyed out (its tooltip says to enter the VID in Settings), and IVAO is never contacted.'
    })

    // The sim switch goes on too: it is greyed out only while it is on and the network's traffic is drawn ("never both").
    await page.evaluate(async () => {
      const w = (globalThis as unknown as { winglog: Winglog }).winglog
      await w.settingsSetOnlineNetwork({
        network: 'vatsim',
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false
      })
      await w.trafficSetSimOn(true)
    })
    await page.waitForTimeout(6000)
    await expect(page.getByRole('button', { name: 'Show sim traffic' })).toBeDisabled()
    await snap(page, {
      file: '3-network.png',
      title: 'VATSIM traffic on, with the sim switch on as well',
      note: 'With no flight tracked the map stays zoomed out, so the two invented aircraft near London show as one amber mark (picture 6 has them up close). The sim button is greyed out, its tooltip "Off while VATSIM traffic is shown": the two are never drawn together.'
    })

    await page.evaluate(() =>
      (globalThis as unknown as { winglog: Winglog }).winglog.trafficSetNetworkOn(false)
    )
    await page.waitForTimeout(3000)
    await snap(page, {
      file: '4-sim-unavailable.png',
      title: 'Sim traffic on, but no sim to read',
      note: 'The sim button is on and the map says "Sim traffic unavailable" (this test has no sim). In a real flight the teal aircraft appear here.'
    })
  } finally {
    await cleanup()
    await feed.close()
  }
})

test('a tracked flight flown online: the BeyondATC note, the controllers card, the runway suggestion and the auto-tune warning', async () => {
  const feed = await startNetworkFeedServer({
    centre: VHHH,
    self: { cid: 1234567, callsign: 'TSTPIL1' },
    station: 'VHHH'
  })
  const beyondAtc = await FakeBeyondAtcServer.start()
  const { window: page, cleanup } = await launchApp({
    env: {
      WINGLOG_E2E_FIXTURE: VHHH_HOP,
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: '1',
      WINGLOG_E2E_REPLAY_HOLD: '1',
      WINGLOG_E2E_VATSIM_URL: feed.vatsimUrl,
      WINGLOG_E2E_IVAO_URL: feed.ivaoUrl,
      ...beyondAtc.env
    }
  })
  try {
    await page.setViewportSize({ width: 1200, height: 800 }).catch(() => undefined)
    // BeyondATC switched on in Settings, so its tab appears. The online network card mentions BeyondATC too, but has no host.
    await page.getByRole('tab', { name: 'Settings' }).click()
    await page.getByRole('tab', { name: '3rd party' }).click()
    const beyondAtcCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: 'BeyondATC' })
      .filter({ has: page.getByLabel('Host') })
    await beyondAtcCard.getByLabel('Host').fill('127.0.0.1')
    await beyondAtcCard.getByRole('button', { name: 'On', exact: true }).click()
    await beyondAtc.waitForConnection()
    await page.evaluate(() =>
      (globalThis as unknown as { winglog: Winglog }).winglog.settingsSetOnlineNetwork({
        network: 'vatsim',
        vatsimCid: '1234567',
        ivaoVid: null,
        keepBeyondAtcOnline: false
      })
    )
    await page.getByRole('tab', { name: 'Track' }).click()
    await page.getByRole('button', { name: 'Free flight' }).click()
    await page.getByRole('button', { name: 'Start tracking' }).click()
    await expect(page.getByText(/BeyondATC is hidden while you are online on VATSIM/)).toBeVisible({
      timeout: 30_000
    })
    await expect(page.getByText('Runway in use (from the ATIS): 07R')).toBeVisible()
    await snap(page, {
      file: '5-online-track.png',
      title: 'Tracked and found online (by CID)',
      note: 'The note says why BeyondATC is hidden. The card lists the invented tower at VHHH with its frequency, the ATIS text, and the runway suggestion above it.'
    })

    await page.evaluate(() =>
      (globalThis as unknown as { winglog: Winglog }).winglog.trafficSetNetworkOn(true)
    )
    // Out from the taxi view (zoom 15) to 8, where the invented aircraft 25 to 45 km away are in the picture.
    const zoomOut = page.getByRole('button', { name: 'Zoom out' })
    for (let step = 0; step < 7; step++) {
      await zoomOut.click()
      await page.waitForTimeout(400)
    }
    await page.waitForTimeout(6000)
    await snap(page.locator('[data-framed]'), {
      file: '6-online-track-traffic.png',
      title: 'The same, with VATSIM traffic on (the map, zoomed out)',
      note: 'The two invented aircraft near VHHH in amber, pointing their heading; the one on the ground is smaller and dimmer. Your own aircraft (the invented TSTPIL1 in the feed, at your position) is not drawn again as traffic.'
    })

    beyondAtc.sendLines('AutoTune: true')
    const warning = page.getByRole('alert').filter({ hasText: "BeyondATC's auto-tune is on" })
    await expect(warning).toBeVisible()
    await snap(page, {
      file: '7-online-autotune-warning.png',
      title: "BeyondATC connected with auto-tune on, while you're online",
      note: 'The amber warning under the BeyondATC note: auto-tune can retune your radios away from the network’s controllers. WingLog never switches it off itself.'
    })

    await page.getByRole('tab', { name: 'BeyondATC' }).click()
    await expect(warning).toBeVisible()
    await snap(
      page.locator('[data-slot="card"]').filter({ has: page.getByRole('button', { name: /^Auto-tune/ }) }),
      {
        file: '8-beyondatc-radios-online.png',
        title: "The BeyondATC page's Radios card, online",
        note: 'The note in place of the frequency picker, then the same warning directly above the Auto-tune button that turns it off.'
      }
    )
  } finally {
    await cleanup()
    await beyondAtc.stop()
    await feed.close()
  }
})
