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
import { appendFileSync, writeFileSync } from 'node:fs'
import { test, type Page } from '@playwright/test'
import { WebSocket } from 'ws'
import { electronBinary } from './electron-binary'
import { launchApp } from './launch-app'
import { thisMachinesUserDataDirectory } from '../src/main/platform/this-machine'

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
        WINGLOG_SHOTS_DB_PATH: join(userDataDir, 'winglog.db'),
        WINGLOG_SHOTS_TAXI_FROM: join(thisMachinesUserDataDirectory() ?? '', 'winglog.db')
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
    // The add-ons' pages exist once the PC has them on; the replay's own sockets stand in for BeyondATC's and GSX's servers.
    await page.evaluate(async () => {
      const api = (globalThis as unknown as Window).winglog
      await api.settingsSetBeyondAtc({ enabled: true, host: '127.0.0.1' })
      await api.settingsSetGsxRemote({ enabled: true, host: 'localhost', port: 8744 })
    })
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
    await portrait.getByRole('navigation').waitFor()

    const flightId = await page.evaluate(
      async () => (await (globalThis as unknown as Window).winglog.flightList())[0].id
    )
    await page.evaluate((id) => (globalThis as unknown as Window).winglog.trackingStart(id), flightId)
    await portrait.waitForTimeout(8_000)
    await portrait.screenshot({ path: join(OUT, '1a-portrait-after-start.png'), animations: 'disabled' })
    console.log(`SECOND SCREEN: http://${address}:${port}/  (already paired in the test window)`)

    await portrait.waitForTimeout(6_000)
    await portrait.screenshot({ path: join(OUT, '1-portrait-early.png') })
    await portrait.getByRole('button', { name: 'Show VFR overlay' }).click()
    await portrait.getByRole('button', { name: 'Show taxi chart' }).click()
    await portrait.waitForTimeout(3_000)
    await portrait.screenshot({ path: join(OUT, '1b-portrait-vfr-taxi.png') })
    await portrait.getByRole('button', { name: 'Procedures…' }).click()
    await portrait.getByRole('dialog').waitFor()
    await portrait.waitForTimeout(1_500)
    await portrait.screenshot({ path: join(OUT, '1c-portrait-procedures.png'), animations: 'disabled' })
    await portrait.getByRole('tab', { name: 'Arrival' }).click()
    await portrait.waitForTimeout(800)
    await portrait.screenshot({
      path: join(OUT, '1d-portrait-procedures-arrival.png'),
      animations: 'disabled'
    })
    const counts = await portrait
      .getByRole('dialog')
      .getByRole('combobox')
      .evaluateAll((els) => els.map((el) => (el as HTMLSelectElement).options.length))
    console.log('ARRIVAL PICKER OPTION COUNTS', JSON.stringify(counts))
    await portrait.keyboard.press('Escape')
    // The other pages, each from the bar along the bottom.
    for (const [name, file] of [
      ['Dispatch', '4a-page-dispatch.png'],
      ['Ground services', '4c-page-gsx.png'],
      ['BeyondATC', '4d-page-beyondatc.png'],
      ['Track', '4e-page-track-again.png']
    ] as const) {
      await portrait.getByRole('navigation').getByRole('button', { name }).click()
      await portrait.waitForTimeout(2_500)
      await portrait.screenshot({ path: join(OUT, file), animations: 'disabled' })
    }
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

    if (process.env.WINGLOG_SHOTS_DIAG) {
      // What a second device is sent through the whole replay, and what the page shows every 25 s.
      const log = join(OUT, 'messages.ndjson')
      writeFileSync(log, '')
      await card.getByRole('button', { name: 'Pair a device' }).click()
      const diagCode =
        (await card
          .locator('[aria-label]')
          .filter({ hasText: /^\d{6}$/ })
          .textContent()) ?? ''
      const raw = new WebSocket(`ws://${address}:${port}/live`)
      raw.on('message', (data) => {
        const m = JSON.parse(data.toString())
        const p = m.payload ?? {}
        appendFileSync(
          log,
          JSON.stringify({
            at: Date.now(),
            t: m.t,
            name: m.name,
            n: Array.isArray(p) ? p.length : undefined,
            id: p.id,
            ts: p.tsUtc,
            seg: p.resumeSegment,
            ex: p.excludedReason,
            lat: p.latitude,
            lon: p.longitude
          }) + '\n'
        )
      })
      await new Promise<void>((resolve) => raw.once('open', () => resolve()))
      raw.send(JSON.stringify({ t: 'pair', code: diagCode, name: 'diag' }))
      for (let i = 1; i <= 10; i++) {
        await portrait.waitForTimeout(25_000)
        await portrait.screenshot({ path: join(OUT, `diag-${String(i).padStart(2, '0')}.png`) })
      }
      raw.close()
    }

    if (HOLD_MIN > 0) {
      // A pairing code lasts 5 minutes and works once, so a held run keeps one open: every few seconds it checks, and as soon as a code has
      // been used or has expired it opens the next and keeps the latest in a file (a second device can then pair straight after the first).
      const codeFile = join(OUT, 'current-code.txt')
      const until = Date.now() + HOLD_MIN * 60_000
      let last = ''
      while (Date.now() < until) {
        try {
          // Straight through the app's own IPC, not the Settings card: a code that cannot be read must never end the held run.
          const code = await page.evaluate(async () => {
            const lan = (globalThis as unknown as Window).winglog
            const open = (await lan.lanGetStatus()).pairing
            return open ? open.code : ((await lan.lanStartPairing()).pairing?.code ?? '')
          })
          if (code !== '' && code !== last) {
            last = code
            writeFileSync(codeFile, code)
            console.log(`PAIRING CODE ${code} for http://${address}:${port}/ (valid 5 min, works once)`)
          }
        } catch (error) {
          console.log(`PAIRING CODE could not be refreshed: ${String(error)}`)
        }
        await page.waitForTimeout(4_000)
      }
    }
  } finally {
    await cleanup()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

async function expectWindows(app: { windows(): Page[] }, before: number): Promise<void> {
  for (let i = 0; i < 50 && app.windows().length <= before; i++) await new Promise((r) => setTimeout(r, 100))
}
