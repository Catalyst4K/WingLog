import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Proves Phase 3's main/index.ts injection seam (flightdeck-backend's docs/plans/
 * flight-replay-harness.md) works through a real launched app, not just at the module
 * level (src/main/tracking/flight-replay.test.ts covers that) — closing test-coverage.md
 * Phase 4's open question about whether SimConnectService is swappable for a fixture
 * connector in an e2e context. WINGLOG_E2E_FIXTURE, read once at startup, swaps in
 * ReplaySimConnectService; its status reports simConnectVersion: 'replay', which the app
 * shell's own connection badge surfaces via real IPC — a real, driven telemetry stream is
 * reaching the renderer, not a live sim.
 *
 * Deliberately doesn't drive a planned flight into Track's live map: that needs seeding a
 * dispatched flight into the isolated per-test DB without a real SimBrief call, which is
 * still an open step (not solved here) — this test's scope is the seam itself.
 */
test('the SimConnect replay seam reaches the renderer through a real app launch', async () => {
  const fixturePath = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')

  const { window, cleanup } = await launchApp({
    env: { WINGLOG_E2E_FIXTURE: fixturePath, WINGLOG_E2E_REPLAY_MODE: 'paced', WINGLOG_E2E_REPLAY_SPEED: '200' }
  })
  try {
    const badge = window.getByText('SimConnect:', { exact: false })
    await expect(badge).toHaveAttribute('title', /replay/, { timeout: 15_000 })
  } finally {
    await cleanup()
  }
})
