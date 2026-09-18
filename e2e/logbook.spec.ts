import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Logbook's browse/detail/delete flow against the real built app, per flightdeck-backend's
 * docs/plans/test-coverage.md Phase 4. Logbook only ever shows *completed* flights, and
 * there's no way to reach that state through the UI alone without either a live sim or a
 * network-dependent SimBrief OFP (Dispatch's "Fetch"/"Generate" both hit a real external
 * service — not something a headless CI run can rely on). So this seeds one real completed
 * flight first, via src/main/tracking/seed-e2e-completed-flight.test.ts — which runs the
 * same committed replay fixture flight-replay.test.ts already replays through the real
 * TrackingController/FlightRecorder/landing-capture pipeline, just written to a real db
 * file instead of `:memory:` — then launches the app pointed at that pre-seeded profile
 * instead of an empty one.
 */
let userDataDir: string

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-logbook-'))
  const dbPath = join(userDataDir, 'winglog.db')
  // Same electron-as-node recipe as package.json's db:migrate/test scripts (better-sqlite3
  // is built for Electron's Node ABI) — the real binary directly (not the node_modules/.bin
  // shim), since that's a .cmd on Windows and execFileSync can't run one without a shell.
  const electronBin = join('node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  execFileSync(electronBin, ['./node_modules/vitest/vitest.mjs', 'run', 'src/main/tracking/seed-e2e-completed-flight.test.ts'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WINGLOG_E2E_SEED_DB_PATH: dbPath },
    stdio: 'inherit'
  })
})

test.afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

test('browses to a completed flight, sees its landing/track detail, and deletes it', async () => {
  const { window, cleanup } = await launchApp({ userDataDir })
  try {
    await window.getByRole('tab', { name: 'Logbook' }).click()
    await expect(window.getByRole('heading', { name: 'Logbook' })).toBeVisible()
    await expect(window.getByText('Total flights')).toBeVisible()

    // The seeded flight — G-TEST, EGLL -> EGCC
    const row = window.getByRole('row', { name: /EGLL.*EGCC/ })
    await expect(row).toBeVisible()
    await row.click()

    // Flight detail: header, landing card (real captured landing data), and the map
    await expect(window.getByText('EGLL → EGCC')).toBeVisible()
    await expect(window.getByText('Landing', { exact: true })).toBeVisible()
    await expect(window.getByText('Touchdown rate')).toBeVisible()
    await expect(window.getByText('23R', { exact: true })).toBeVisible()

    // Delete — the confirm button shares its accessible name with the trigger that opened
    // it, so the second click is scoped to the dialog itself, rather than a bare role query
    // that could still resolve the original page button for a moment.
    await window.getByRole('button', { name: 'Delete flight' }).click()
    const confirmDialog = window.getByRole('alertdialog')
    await expect(confirmDialog.getByRole('heading', { name: 'Delete this flight?' })).toBeVisible()
    await confirmDialog.getByRole('button', { name: 'Delete flight' }).click()
    await expect(confirmDialog).toBeHidden()

    // Navigating away unmounts FlightDetail's FlightMap (a real maplibre-gl/WebGL map) —
    // a generous timeout here, since that teardown plus flightDelete's IPC round trip and
    // LogbookView's own four-way reload() all take measurably longer on a loaded CI runner
    // than locally. Only this flight is gone — the other seeded flight (G-CIRC, used by
    // the Landings sub-tab test below) is untouched, so the list isn't empty.
    await expect(window.getByRole('heading', { name: 'Logbook' })).toBeVisible({ timeout: 15_000 })
    await expect(window.getByRole('row', { name: /EGLL.*EGCC/ })).toHaveCount(0)
  } finally {
    await cleanup()
  }
})

test('browses the Landings sub-tab and switches between a flight\'s several landings (flightdeck-backend docs/plans/multiple-landings.md)', async () => {
  const { window, cleanup } = await launchApp({ userDataDir })
  try {
    await window.getByRole('tab', { name: 'Logbook' }).click()
    await expect(window.getByRole('heading', { name: 'Logbook' })).toBeVisible()

    // The seeded circuits flight (G-CIRC, VHHH) shows a ×N badge next to its score, on the
    // default Flights tab.
    const circuitsRow = window.getByRole('row', { name: /G-CIRC/ })
    await expect(circuitsRow).toBeVisible()
    await expect(circuitsRow.getByText(/×\d/)).toBeVisible()

    // The Landings sub-tab lists every touchdown across the fleet, not one row per flight.
    await window.getByRole('tab', { name: 'Landings' }).click()
    await expect(window.getByRole('columnheader', { name: /Touchdown rate/ })).toBeVisible()
    const landingRows = window.getByRole('row', { name: /G-CIRC/ })
    await expect(landingRows).toHaveCount(4)

    // Clicking a landing opens its flight, same as clicking a flight row does.
    await landingRows.first().click()
    await expect(window.getByText('G-CIRC')).toBeVisible()
    await expect(window.getByText('Landing', { exact: true })).toBeVisible()

    // Several landings on one flight: a tab per touchdown, defaulting to the final one.
    // Scoped to the card's own labeled tablist — the app's top-level nav uses role="tab"
    // too, and an unscoped query would pick those up as well. Selected by position, not by
    // name: several of this real flight's touch-and-goes share the same runway and (thanks
    // to instant-mode replay compressing the whole flight into a few real seconds) the same
    // to-the-minute touchdown time, so labels aren't guaranteed unique here the way they
    // would be across a real flight's actual elapsed time.
    const landingTabs = window.getByRole('tablist', { name: 'Select landing' }).getByRole('tab')
    await expect(landingTabs).toHaveCount(4)
    await expect(landingTabs.last()).toHaveAttribute('data-state', 'active') // defaults to final
    await landingTabs.first().click()
    await expect(landingTabs.first()).toHaveAttribute('data-state', 'active')
    await expect(landingTabs.last()).toHaveAttribute('data-state', 'inactive')
  } finally {
    await cleanup()
  }
})
