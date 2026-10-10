import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { launchApp } from './launch-app'
import { FakeBeyondAtcServer, LARGE_REAL_SNAPSHOT } from './beyondatc-server'
import { FakeGsxRemoteServer, VHHH_BOOT_SNAPSHOT } from './gsx-remote-server'
import { electronBinary } from './electron-binary'

/**
 * Generates the manual's screenshots into docs/manual/images (winglog-backend's
 * docs/plans/user-docs-v1-4.md, "Images"): the real built app, on a demo profile seeded from
 * the committed replay fixtures and fake add-on servers, never anyone's real data. Light theme,
 * English, a fixed window size, so a re-run after a UI change gives matching images.
 *
 * Run with `npm run manual:screenshots` (builds first). Not part of the e2e suite: it writes
 * files and needs BeyondATC's real port free (close BeyondATC first).
 */
const OUT = join(process.cwd(), 'docs', 'manual', 'images')
const WIDTH = 1440
const HEIGHT = 900

async function prepare(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.setSize(size.width, size.height)
      win.center()
    },
    { width: WIDTH, height: HEIGHT }
  )
  // Light theme for print. App reads the theme at start, so reload to apply it.
  await page.evaluate(() => (globalThis as unknown as Window).winglog.settingsSetTheme('light'))
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
}

async function shot(page: Page, name: string): Promise<void> {
  // Let maps and charts settle before capturing.
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

function seededProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'winglog-manual-shots-'))
  const electronBin = electronBinary()
  execFileSync(
    electronBin,
    ['./node_modules/vitest/vitest.mjs', 'run', 'src/main/tracking/seed-e2e-completed-flight.test.ts'],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WINGLOG_E2E_SEED_DB_PATH: join(dir, 'winglog.db') },
      stdio: 'inherit'
    }
  )
  return dir
}

/**
 * One consistent clearance exchange for the BeyondATC page, on the same flight as
 * LARGE_REAL_SNAPSHOT (Singapore 830 Super, WSSS -> ZSPD, ATIS B: departures 20C). The wording
 * follows real BeyondATC lines from Player.log (2026-10-02, ZSPD); ANIT8B is a real WSSS SID
 * off 20C in the sim's navdata.
 */
const DEMO_CLEARANCE = [
  'CommsState: {"mode": "awaiting", "text": "Awaiting Response"}',
  'Player: Singapore Delivery, Singapore 830 Super, Airbus A380-800, request IFR clearance to Pudong airport, Information B.',
  'CommsState: {"mode": "speaking", "text": "Speaking"}',
  'ATC: Singapore 830 Super, Singapore Delivery, information B correct, cleared to Pudong via ANIT8B departure, runway 20C, climb via SID to 5,000, squawk 2341.',
  'Player: Cleared to Pudong via ANIT8B departure, runway 20C, climb via SID to 5,000, squawk 2341, Singapore 830 Super.',
  'ATC: Singapore 830 Super, readback correct. Contact ground 124.3 when ready for pushback or engine start.',
  'CommsState: {"mode": "ready", "text": ""}'
]

test.beforeAll(() => mkdirSync(OUT, { recursive: true }))

test('first-launch setup', async () => {
  const { app, window: page, cleanup } = await launchApp({ keepSetup: true })
  try {
    await prepare(app, page)
    await expect(page.getByRole('dialog', { name: 'Welcome to WingLog' })).toBeVisible()
    await shot(page, 'setup-welcome')
    await page.getByRole('button', { name: 'Get started' }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByRole('dialog', { name: 'Add-ons' })).toBeVisible()
    await shot(page, 'setup-addons')
  } finally {
    await cleanup()
  }
})

test('fleet, logbook and settings on a seeded profile', async () => {
  const userDataDir = seededProfile()
  const { app, window: page, cleanup } = await launchApp({ userDataDir })
  try {
    await prepare(app, page)
    // A small demo fleet alongside the seeded G-TEST.
    await page.evaluate(async () => {
      const api = (globalThis as unknown as Window).winglog
      await api.aircraftCreate({
        registration: 'G-WLAA',
        icaoType: 'A20N',
        operator: 'Demo Air',
        currentIcao: 'EGLL'
      })
      await api.aircraftCreate({
        registration: 'G-WLAB',
        icaoType: 'B38M',
        operator: 'Demo Air',
        currentIcao: 'EGCC'
      })
      await api.aircraftCreate({
        registration: 'G-WLHV',
        icaoType: 'A359',
        operator: 'Demo Air',
        currentIcao: 'VHHH'
      })
    })
    // Fleet reads its list when it opens: leave and come back to pick up the new aircraft.
    await page.getByRole('tab', { name: 'Logbook' }).click()
    await page.getByRole('tab', { name: 'Fleet' }).click()
    await expect(page.getByText('G-WLHV')).toBeVisible()
    await shot(page, 'fleet')

    await page.getByRole('tab', { name: 'Logbook' }).click()
    const row = page.getByRole('row', { name: /EGLL.*EGCC/ })
    await expect(row).toBeVisible()
    await shot(page, 'logbook-list')
    await row.click()
    await expect(page.getByText('Touchdown rate')).toBeVisible()
    await shot(page, 'logbook-detail')

    await page.getByRole('tab', { name: 'Settings' }).click()
    await expect(page.getByText('Units')).toBeVisible()
    await shot(page, 'settings-ui')
    await page.getByRole('tab', { name: 'About' }).click()
    await expect(page.getByRole('button', { name: 'Manual (PDF)' })).toBeVisible()
    await shot(page, 'settings-about')
  } finally {
    await cleanup()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('a live free flight on Track', async () => {
  const fixturePath = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')
  const {
    app,
    window: page,
    cleanup
  } = await launchApp({
    env: {
      WINGLOG_E2E_FIXTURE: fixturePath,
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: '40'
    }
  })
  try {
    await prepare(app, page)
    await page.getByRole('tab', { name: 'Track' }).click()
    await page.getByRole('button', { name: 'Free flight' }).click()
    await page.getByRole('button', { name: 'Start tracking' }).click()
    // Into the climb, so the map shows a trail behind the aircraft.
    await expect(page.getByText(/Phase:\s*climb/i)).toBeVisible({ timeout: 240_000 })
    await page.waitForTimeout(10_000)
    await shot(page, 'track')
  } finally {
    await cleanup()
  }
})

test('the BeyondATC page', async () => {
  const server = await FakeBeyondAtcServer.start()
  const { app, window: page, cleanup } = await launchApp({ env: server.env })
  try {
    await prepare(app, page)
    await page.evaluate(() =>
      (globalThis as unknown as Window).winglog.settingsSetBeyondAtc({ enabled: true, host: '127.0.0.1' })
    )
    await server.waitForConnection()
    server.sendLines(...LARGE_REAL_SNAPSHOT)
    server.sendLines(...DEMO_CLEARANCE)
    await page.reload()
    await page.getByRole('tab', { name: 'BeyondATC' }).click()
    await expect(page.getByText('Latest instruction')).toBeVisible()
    await shot(page, 'beyondatc')
  } finally {
    await cleanup()
    await server.stop()
  }
})

test('the Ground services page', async () => {
  const server = await FakeGsxRemoteServer.start()
  const { app, window: page, cleanup } = await launchApp()
  try {
    await prepare(app, page)
    await page.evaluate(
      (port) =>
        (globalThis as unknown as Window).winglog.settingsSetGsxRemote({
          enabled: true,
          host: '127.0.0.1',
          port
        }),
      server.port
    )
    await server.waitForConnection()
    server.sendSnapshot(VHHH_BOOT_SNAPSHOT)
    await page.reload()
    await page.getByRole('tab', { name: 'Ground services' }).click()
    await expect(page.getByText('GSX Menu')).toBeVisible()
    await shot(page, 'gsx')
  } finally {
    await cleanup()
    await server.stop()
  }
})
