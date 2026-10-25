/**
 * The online-network traffic and the sim's own traffic as Callum would see them (winglog-backend docs/plans/vatsim-build.md, Steps 1 and
 * 4b): the built app replays a short hop out of EGLL, a fake VATSIM feed puts two invented aircraft nearby, and pictures are taken of the
 * Track map with each layer's button in each state. Writes release/sim/online-traffic/ (gitignored) with an index.html to look through.
 * Run with `npm run sim:online-traffic` (builds first); needs BeyondATC and WingLog closed. No real network is read: the feed is a local
 * server of invented aircraft, and the sim is never reachable (so the teal layer shows its "unavailable" pill, not aircraft: that part is
 * checked by eye in a real flight with BeyondATC running).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type Locator, type Page } from '@playwright/test'
import { launchApp } from './launch-app'
import { startNetworkFeedServer } from './network-feed-server'

const OUT = join(process.cwd(), 'release', 'sim', 'online-traffic')
const FIXTURE = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')
const EGLL = { lat: 51.47, lon: -0.46 }

type Winglog = Window['winglog']

interface Shot {
  file: string
  title: string
  note: string
}

async function snap(shots: Shot[], target: Page | Locator, shot: Shot): Promise<void> {
  await target.screenshot({ path: join(OUT, shot.file), animations: 'disabled' })
  shots.push(shot)
}

function report(shots: Shot[]): string {
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
<h1>Online traffic: what to look at</h1>
<p>Amber aircraft are the network's (invented, from a local feed). The sim's own aircraft are teal; they need a real flight with BeyondATC running.</p>
${figures}</body></html>`
}

test('the traffic layers, their buttons and what they say', async () => {
  mkdirSync(OUT, { recursive: true })
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
  const shots: Shot[] = []
  try {
    await page.setViewportSize({ width: 1200, height: 800 }).catch(() => undefined)
    await page.getByRole('tab', { name: 'Track' }).click()
    await page.waitForTimeout(3000)
    await snap(shots, page, {
      file: '1-off.png',
      title: 'Both layers off',
      note: 'No network chosen: only the sim traffic button (the lower of the two aeroplane buttons) is offered.'
    })

    await page.evaluate(async () => {
      const w = (globalThis as unknown as { winglog: Winglog }).winglog
      await w.settingsSetOnlineNetwork({
        network: 'vatsim',
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false
      })
      await w.trafficSetNetworkOn(true)
    })
    await page.waitForTimeout(6000)
    await snap(shots, page, {
      file: '2-network.png',
      title: 'VATSIM traffic on',
      note: 'The two invented aircraft in amber, pointing their heading; the one on the ground is smaller and dimmer. The sim button is greyed out: "Off while VATSIM traffic is shown".'
    })

    await page.evaluate(async () => {
      const w = (globalThis as unknown as { winglog: Winglog }).winglog
      await w.trafficSetNetworkOn(false)
      await w.trafficSetSimOn(true)
    })
    await page.waitForTimeout(3000)
    await snap(shots, page, {
      file: '3-sim-unavailable.png',
      title: 'Sim traffic on, but no sim to read',
      note: 'The sim button is on and the map says "Sim traffic unavailable" (this test has no sim). In a real flight the teal aircraft appear here.'
    })
  } finally {
    writeFileSync(join(OUT, 'index.html'), report(shots))
    await cleanup()
    await feed.close()
  }
})
