import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Drives free-flight-tracking.md's whole point through a real launched app: scenario #15
 * (flight-replay-harness.md, 2026-09-14) — a VHHH VFR hop with no SimBrief plan — used to
 * have no path into WingLog at all (TrackView only listed `status === 'planned'` flights).
 * Uses the same committed replay fixture src/main/tracking/flight-replay.test.ts already
 * drives through TrackingController.startFree at the module level; this test's own job is
 * proving the renderer's plumbing on top of it — the Free flight card, the dialog's
 * prefill/aircraft-creation, and the finished flight actually landing in Logbook — not
 * re-proving the capture logic itself.
 *
 * Paced mode, not instant (unlike track-replay.spec.ts's own connection-badge check, which
 * only needs main's own pulled getSimConnectionStatus and never touches telemetry): the
 * renderer only ever *receives* telemetry — there's no equivalent "pull the current value"
 * IPC call, only the onSimTelemetry push — so an instant-mode replay (every tick fired
 * within a handful of main-process setImmediate callbacks) reliably finishes and stops
 * pushing before the separate renderer process has even mounted far enough to attach its
 * listener, and every tick sent to nobody is simply lost. Paced mode at 200x still finishes
 * in a few real seconds, but spreads ticks out enough that the renderer's subscription
 * reliably wins the race — confirmed by waiting for a real (non-"N/A") speed reading below
 * before touching anything that depends on telemetry.
 */
test('starts a free flight from Track and finds it, completed, in the Logbook', async () => {
  const fixturePath = join(process.cwd(), 'src/main/tracking/__fixtures__/tier2-vfr-no-ofp-short-hop.ndjson')

  const { window, cleanup } = await launchApp({
    env: {
      WINGLOG_E2E_FIXTURE: fixturePath,
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: '200'
    }
  })
  try {
    await window.getByRole('tab', { name: 'Track' }).click()
    await expect(window.getByRole('heading', { name: 'Track' })).toBeVisible()
    await expect(window.getByText(/Speed: \d/)).toBeVisible({ timeout: 15_000 })

    await window.getByRole('button', { name: 'Free flight' }).click()
    await expect(window.getByText('Start a free flight')).toBeVisible()
    // A fresh profile has no fleet aircraft at all — the dialog defaults to offering to add
    // the sim-reported registration/type (the fixture's scrubbed G-TEST, a real C172), which
    // this just accepts as-is rather than picking an existing tail.
    await expect(window.getByText(/Add G-TEST \(C172\) to fleet/)).toBeVisible()
    await window.getByRole('button', { name: 'Start tracking' }).click()

    // Now actively tracking, with no planned flight ever having existed for it.
    await expect(window.getByText(/Phase:/)).toBeVisible()

    // This fixture's capture ends parked but with the engine still running and the parking
    // brake never set (flight-replay.test.ts's own describe block has the same real-data
    // quirk) — shutdown detection never fires on its own, so a pilot presses "Finish & save"
    // here, same as this does.
    await window.getByRole('button', { name: 'Finish & save' }).click()
    const confirmDialog = window.getByRole('alertdialog')
    await confirmDialog.getByRole('button', { name: 'Finish & save' }).click()
    await expect(confirmDialog).toBeHidden()

    await window.getByRole('tab', { name: 'Logbook' }).click()
    await expect(window.getByRole('heading', { name: 'Logbook' })).toBeVisible()

    const row = window.getByRole('row', { name: /G-TEST/ })
    await expect(row).toBeVisible()
    // The Free flight badge (Phase 4) — this row has no ofp_json, distinguishing it from a
    // dispatched flight without a new column.
    await expect(row.getByText('Free flight')).toBeVisible()
  } finally {
    await cleanup()
  }
})
