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
    // it, so the second click is scoped to the dialog itself. Passing under Windows/local
    // but flaky under Linux CI otherwise (`getByRole('button', { name: 'Delete flight' })`
    // unscoped can still resolve the original page button for a moment while the dialog's
    // aria-hidden-on-background hasn't been applied yet).
    await window.getByRole('button', { name: 'Delete flight' }).click()
    const confirmDialog = window.getByRole('alertdialog')
    await expect(confirmDialog.getByRole('heading', { name: 'Delete this flight?' })).toBeVisible()
    await confirmDialog.getByRole('button', { name: 'Delete flight' }).click()
    // Confirms the click actually registered (dialog closes) before checking what's behind
    // it — the dialog itself closes as soon as useConfirm()'s promise resolves, before
    // handleDelete's actual `await window.winglog.flightDelete(...)` even runs, so this
    // alone doesn't prove the delete succeeded — only that the confirm click landed.
    await expect(confirmDialog).toBeHidden()

    const listHeading = window.getByRole('heading', { name: 'Logbook' })
    try {
      await expect(listHeading).toBeVisible({ timeout: 15_000 })
    } catch (err) {
      // A failed flightDelete IPC call surfaces as a toast, not a heading — this stays in
      // detail view in that case (handleDelete's catch swallows it, never calling
      // onDeleted()). Surface the toast text so a CI-only failure here is diagnosable from
      // the log instead of just "heading never appeared".
      const toastText = await window
        .locator('[data-sonner-toast]')
        .allTextContents()
        .catch(() => ['<could not read toast>'])
      throw new Error(`Logbook heading never reappeared after delete. Toast content: ${JSON.stringify(toastText)}. Original error: ${err}`)
    }
    await expect(window.getByText('No completed flights yet')).toBeVisible()
  } finally {
    await cleanup()
  }
})
