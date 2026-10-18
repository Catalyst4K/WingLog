/**
 * Real-app screenshots for `npm run sim -- flight` (winglog-backend docs/plans/robustness/scenario-testing.md Part 6): the built app
 * replays flight 236's last 36 minutes into WSSS (scripts/scenarios/__fixtures__/wsss-236-descent.ndjson, telemetry and BeyondATC's
 * stream) and a screenshot is taken at each decision point of the descent. Writes release/sim/flight/screens/ (gitignored); the next
 * `npm run sim -- flight` puts them in the report. Run with `npm run sim:screens` (builds first). Needs BeyondATC and WingLog closed.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { electronBinary } from './electron-binary'
import { launchApp } from './launch-app'

const OUT = join(process.cwd(), 'release', 'sim', 'flight', 'screens')
/** Playback speed: 36 minutes in about 40 s. */
const SPEED = 55

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

test('the descent through the real app, with a picture at each decision', async () => {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const userDataDir = mkdtempSync(join(tmpdir(), 'winglog-shots-'))
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
  const {
    app,
    window: page,
    cleanup
  } = await launchApp({
    userDataDir,
    env: {
      WINGLOG_E2E_FIXTURE: join(process.cwd(), 'scripts/scenarios/__fixtures__/wsss-236-descent.ndjson'),
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: String(SPEED),
      WINGLOG_E2E_REPLAY_STREAMS: '1',
      WINGLOG_E2E_REPLAY_HOLD: '1'
    }
  })
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.setSize(1440, 900)
      win.center()
    })
    // The BeyondATC tab exists once the integration is on; the replay's socket stands in for BeyondATC's server.
    await page.evaluate(() =>
      (globalThis as unknown as Window).winglog.settingsSetBeyondAtc({ enabled: true, host: '127.0.0.1' })
    )
    await page.reload()
    // After a reload the app asks about the planned flight it finds; keep it.
    const keep = page.getByRole('button', { name: 'Keep it' })
    if (
      await keep.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false
      )
    )
      await keep.click()
    await page.getByRole('tab', { name: 'BeyondATC' }).click()
    await shot(page, '1-before-tracking')

    const flightId = await page.evaluate(async () => {
      const flights = await (globalThis as unknown as Window).winglog.flightList()
      return flights[0].id
    })
    await page.evaluate((id) => (globalThis as unknown as Window).winglog.trackingStart(id), flightId)

    // The STAR clearance: the card and the boxes appear with it.
    await expect(page.getByText('TEBU1B').first()).toBeVisible({ timeout: 60_000 })
    await shot(page, '2-star-cleared')
    await page.getByRole('button', { name: 'Dismiss' }).click()

    // The approach clearance, minutes later in the recording.
    await expect(page.getByText(/R-NAV approach runway 20R/i).first()).toBeVisible({ timeout: 60_000 })
    await shot(page, '3-approach-cleared')
    await page.getByRole('button', { name: 'Update' }).click()
    await shot(page, '3b-after-update')

    await page.getByRole('tab', { name: 'Track' }).click()
    await shot(page, '4-track-on-approach')
  } finally {
    await cleanup()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
