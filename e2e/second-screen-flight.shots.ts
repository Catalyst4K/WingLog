/**
 * The second screen through a real flight (winglog-backend docs/plans/lan-web-viewer.md): the built app replays flight 236's last 36
 * minutes into WSSS, a phone-sized page pairs with it and follows the aircraft, and pictures are taken in portrait and landscape.
 * Writes release/sim/second-screen/ (gitignored). Run with `npm run sim:second-screen` (builds first); needs BeyondATC and WingLog closed.
 * Set WINGLOG_SHOTS_HOLD_MIN=N to keep the replay running N minutes afterwards on this PC's real network address, printing the address
 * and a pairing code, so a real phone or browser can watch it; WINGLOG_SHOTS_SPEED sets the playback speed (default 55).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test, type Page } from '@playwright/test'
import { electronBinary } from './electron-binary'
import { launchApp } from './launch-app'

const OUT = join(process.cwd(), 'release', 'sim', 'second-screen')
const SPEED = Number(process.env.WINGLOG_SHOTS_SPEED ?? 55)
const HOLD_MIN = Number(process.env.WINGLOG_SHOTS_HOLD_MIN ?? 0)

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

/** This PC's first private Ethernet or Wi-Fi address, for the held run. */
function lanAddress(): string {
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (/vethernet|wsl|vpn|docker/i.test(name)) continue
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address))
        return a.address
  }
  throw new Error('no private address')
}

test('the second screen follows a replayed flight, in portrait and landscape', async () => {
  test.setTimeout(HOLD_MIN * 60_000 + 240_000)
  mkdirSync(OUT, { recursive: true })
  const userDataDir = mkdtempSync(join(tmpdir(), 'winglog-ss-'))
  execFileSync(
    electronBinary(),
    ['./node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/sim/vitest.config.ts', 'shots-seed'],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WINGLOG_SHOTS_DB_PATH: join(userDataDir, 'winglog.db')
      },
      stdio: 'inherit'
    }
  )
  const address = HOLD_MIN > 0 ? lanAddress() : '127.0.0.1'
  const port = HOLD_MIN > 0 ? 8790 : await freePort()
  const {
    app,
    window: page,
    cleanup
  } = await launchApp({
    userDataDir,
    env: {
      WINGLOG_E2E_LAN_ADDRESS: address,
      WINGLOG_E2E_FIXTURE: join(process.cwd(), 'scripts/scenarios/__fixtures__/wsss-236-descent.ndjson'),
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: String(SPEED),
      WINGLOG_E2E_REPLAY_STREAMS: '1',
      WINGLOG_E2E_REPLAY_HOLD: '1'
    }
  })
  try {
    await page.reload()
    const keep = page.getByRole('button', { name: 'Keep it' })
    if (
      await keep.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false
      )
    )
      await keep.click()

    await page.getByRole('tab', { name: 'Settings' }).click()
    await page.getByRole('tab', { name: 'Data' }).click()
    const card = page.locator('[data-slot="card"]').filter({ hasText: 'Second screen' })
    await card.getByRole('button', { name: 'On', exact: true }).click()
    const portBox = card.getByRole('textbox', { name: 'Port' })
    await portBox.fill(String(port))
    await portBox.blur()
    await card.getByText(`http://${address}:${port}/`).waitFor()
    await card.getByRole('button', { name: 'Pair a device' }).click()
    const code =
      (await card
        .locator('[aria-label]')
        .filter({ hasText: /^\d{6}$/ })
        .textContent()) ?? ''

    const open = async (width: number, height: number): Promise<Page> => {
      const before = app.windows().length
      await app.evaluate(
        async ({ BrowserWindow }, args) => {
          const w = new BrowserWindow({
            show: false,
            width: args.width,
            height: args.height,
            useContentSize: true
          })
          await w.loadURL(args.url)
        },
        { url: `http://${address}:${port}/`, width, height }
      )
      await expectWindows(app, before)
      return app.windows().at(-1)!
    }
    const portrait = await open(390, 780)
    await portrait.getByLabel('Pairing code').fill(code)
    await portrait.getByRole('button', { name: 'Pair' }).click()
    await portrait.getByText('No flight is being tracked').waitFor()

    const flightId = await page.evaluate(
      async () => (await (globalThis as unknown as Window).winglog.flightList())[0].id
    )
    await page.evaluate((id) => (globalThis as unknown as Window).winglog.trackingStart(id), flightId)
    await portrait.getByText('No flight is being tracked').waitFor({ state: 'hidden', timeout: 30_000 })
    console.log(`SECOND SCREEN: http://${address}:${port}/  (already paired in the test window)`)

    await portrait.waitForTimeout(6_000)
    await portrait.screenshot({ path: join(OUT, '1-portrait-early.png') })
    await portrait.waitForTimeout(12_000)
    await portrait.screenshot({ path: join(OUT, '2-portrait-descent.png') })

    const landscape = await open(844, 390)
    await landscape
      .getByText('Pair with WingLog')
      .or(landscape.getByText(/Speed:/))
      .first()
      .waitFor()
    if (await landscape.getByLabel('Pairing code').isVisible()) {
      const second = await page.evaluate(() => 'open')
      void second
    }
    await landscape.waitForTimeout(500)
    await landscape.screenshot({ path: join(OUT, '3-landscape-before-pairing.png') })

    if (HOLD_MIN > 0) {
      await card
        .getByRole('button', { name: 'Pair a device' })
        .click()
        .catch(() => undefined)
      const fresh =
        (await card
          .locator('[aria-label]')
          .filter({ hasText: /^\d{6}$/ })
          .textContent()) ?? ''
      console.log(`HOLDING ${HOLD_MIN} min. Open http://${address}:${port}/ and pair with code ${fresh}`)
      await page.waitForTimeout(HOLD_MIN * 60_000)
    }
  } finally {
    await cleanup()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

async function expectWindows(app: { windows(): Page[] }, before: number): Promise<void> {
  for (let i = 0; i < 50 && app.windows().length <= before; i++) await new Promise((r) => setTimeout(r, 100))
}
