/**
 * The ATC layer as Callum would see it (winglog-backend docs/plans/online-atc-map.md, D5): the built app replays a flight at Heathrow, a
 * fake VATSIM feed puts invented controllers on the real community areas (London's centre sectors, the Heathrow and Gatwick directors) and
 * on airports (tower, ground, delivery, an ATIS), and pictures are taken of the Track map with the ATC button off and on, zoomed out and in,
 * in light and dark, and with the traffic layer on as well. Writes release/sim/online-atc/ (gitignored) with an index.html to look through.
 * Run with `npm run sim:online-atc` (builds first); the sim must be closed. The map's tiles come from the real tile server; no network
 * feed is read: the feed is a local server of invented controllers.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchApp } from './launch-app'
import { startNetworkFeedServer } from './network-feed-server'

const OUT = join(process.cwd(), 'release', 'sim', 'online-atc')
const EGLL_HOP = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')
const EGLL = { lat: 51.47, lon: -0.46 }

type Winglog = Window['winglog']

interface Shot {
  file: string
  title: string
  note: string
}

const shots: Shot[] = []

async function snap(page: Page, shot: Shot): Promise<void> {
  // The map's box, so the picture is the map and its buttons and pills, not the whole window.
  await page
    .locator('.maplibregl-map')
    .first()
    .screenshot({ path: join(OUT, shot.file), animations: 'disabled' })
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
<title>Online ATC check</title>
<style>body{font:15px system-ui;margin:0 auto;max-width:1100px;padding:16px;background:#fafafa;color:#111}
figure{margin:0 0 28px}img{max-width:100%;border:1px solid #ccc;border-radius:8px}figcaption{margin-top:6px}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}img{border-color:#444}}</style></head><body>
<h1>ATC coverage on the map: what to look at</h1>
<p>Purple is a staffed centre (London's Central, Dover and Clacton sectors here), pink an approach area (the Heathrow and Gatwick directors), and the
dark dots are airports with something staffed: D delivery, G ground, T tower, A an approach with no area of its own, I an ATIS. Every controller is
invented, from a local feed. Look for: whether the areas read as areas without hiding the map, whether the labels are legible and not a wall of text
zoomed out, the dots and their letters, the colours in light and dark, and traffic (amber) showing over the areas rather than under them.</p>
${figures}</body></html>`
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }))
test.afterAll(() => writeFileSync(join(OUT, 'index.html'), report()))

test('the ATC layer over London, zoomed out and in, light and dark, with and without traffic', async () => {
  test.setTimeout(240_000)
  const feed = await startNetworkFeedServer({
    centre: EGLL,
    coverage: true,
    splitStation: 'EGLL',
    extraControllers: [
      { callsign: 'LON_D_CTR', frequency: '129.425', facility: 6 },
      { callsign: 'LON_E_CTR', frequency: '134.900', facility: 6 },
      { callsign: 'EGKK_APP', frequency: '126.825', facility: 5 },
      { callsign: 'EGKK_TWR', frequency: '124.225', facility: 4 },
      { callsign: 'EGLL_GND', frequency: '121.700', facility: 3 },
      { callsign: 'EGLL_DEL', frequency: '121.975', facility: 2 },
      { callsign: 'EGLC_TWR', frequency: '118.075', facility: 4 },
      { callsign: 'EGSS_APP', frequency: '120.625', facility: 5 }
    ]
  })
  const { window: page, cleanup } = await launchApp({
    env: {
      WINGLOG_E2E_FIXTURE: EGLL_HOP,
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: '1',
      WINGLOG_E2E_REPLAY_HOLD: '1',
      WINGLOG_E2E_VATSIM_URL: feed.vatsimUrl,
      WINGLOG_E2E_IVAO_URL: feed.ivaoUrl
    }
  })
  const zoomOut = async (times: number): Promise<void> => {
    for (let i = 0; i < times; i++) {
      await page.getByRole('button', { name: 'Zoom out' }).click()
      // A press while the last one is still easing is swallowed, so wait for each.
      await page.waitForTimeout(700)
    }
    // The tiles and the layer draw once the map has settled.
    await page.waitForTimeout(3500)
  }
  const zoomIn = async (times: number): Promise<void> => {
    for (let i = 0; i < times; i++) {
      await page.getByRole('button', { name: 'Zoom in' }).click()
      await page.waitForTimeout(700)
    }
    await page.waitForTimeout(3500)
  }
  try {
    await page.setViewportSize({ width: 1200, height: 900 }).catch(() => undefined)
    await page.evaluate(async () => {
      const w = (globalThis as unknown as { winglog: Winglog }).winglog
      await w.settingsSetTheme('light')
      await w.settingsSetOnlineNetwork({
        network: 'vatsim',
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      })
    })
    await page.getByRole('tab', { name: 'Track' }).click()
    await page.getByRole('button', { name: 'Free flight' }).click()
    await page.getByRole('button', { name: 'Start tracking' }).click()
    await expect(page.locator('.maplibregl-marker')).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(3500)
    await snap(page, {
      file: '1-off.png',
      title: 'ATC off',
      note: 'Heathrow, followed. The new radio-mast button is under the two traffic buttons at the top right; it reads "Show VATSIM ATC".'
    })

    // The map follows the aircraft, which would pull every zoom back to the airport: stop it, then step out from Heathrow.
    await page.getByRole('button', { name: 'Stop centering on aircraft' }).click()
    await page.getByRole('button', { name: 'Show VATSIM ATC' }).click()
    await expect(page.getByRole('button', { name: 'Hide VATSIM ATC' })).toBeVisible()
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => (globalThis as unknown as Window).winglog.getNetworkAtc())).areas.length,
        { timeout: 30_000 }
      )
      .toBeGreaterThan(3)
    await zoomOut(5)
    await snap(page, {
      file: '2-london-close.png',
      title: 'ATC on, five steps out from Heathrow',
      note: 'The Heathrow director (pink) and the London sector it sits in (purple), with the labels, the dots for the airports and their letters.'
    })

    // The cards: press Heathrow's dot (it sits just east of the aircraft at this zoom), then the Heathrow director's area.
    const map = page.locator('.maplibregl-map').first()
    await map.click({ position: { x: 605, y: 285 } })
    await page.waitForTimeout(800)
    await snap(page, {
      file: '2b-card-airport.png',
      title: 'Pressing an airport’s dot',
      note: 'The card: the airport, then a row for each station (what it is, the callsign, the frequency), and the ATIS stations last, with their information letter.'
    })
    await map.click({ position: { x: 700, y: 430 } })
    await page.waitForTimeout(800)
    await snap(page, {
      file: '2c-card-area.png',
      title: 'Pressing an area',
      note: 'The same card for an area: its name, then who is on it (kind, callsign, frequency), every area under the click listed, the approach first.'
    })
    await map.click({ position: { x: 100, y: 500 } })

    await zoomOut(3)
    await snap(page, {
      file: '3-london-wider.png',
      title: 'Three steps further out',
      note: 'The approach areas of Heathrow, Gatwick, London City and Stansted with their labels, inside the purple sectors.'
    })

    await zoomOut(3)
    await snap(page, {
      file: '4-uk.png',
      title: 'South-east England',
      note: 'Zoomed out: only the centres, shaded and labelled, and the dots. Check it still reads as a map, not a purple wall.'
    })

    await page.getByRole('button', { name: 'Show VATSIM traffic' }).click()
    await expect(page.getByRole('button', { name: 'Hide VATSIM traffic' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Hide VATSIM ATC' })).toBeVisible()
    await zoomIn(4)
    await snap(page, {
      file: '5-with-traffic.png',
      title: 'ATC and VATSIM traffic together',
      note: 'The two switches are independent, so both read as on. The amber aircraft (two invented ones, north-east and south of Heathrow) should be over the areas, never under them.'
    })

    // Dark, from Settings as a pilot would: the map is rebuilt when Track opens again, with the layers made for dark.
    await page.getByRole('tab', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.getByRole('tab', { name: 'Track' }).click()
    await page.waitForTimeout(6000)
    await snap(page, {
      file: '6-dark.png',
      title: 'The same, in dark mode',
      note: 'Dark theme, from Settings, with Track opened again: the labels, dots and areas are drawn for dark.'
    })
  } finally {
    await cleanup()
    await feed.close()
  }
})
