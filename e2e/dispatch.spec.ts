import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Dispatch's "Plan a flight" form mechanics against the real built app, per flightdeck-
 * backend's docs/plans/test-coverage.md Phase 4. Deliberately scoped short of an actual
 * "Fly": both "Fetch latest OFP" and "Generate…" hit the real SimBrief API/broker service,
 * and there's no local/offline path to a real DispatchOfp at all (confirmed while building
 * this — unlike Track, which flight-replay-harness.md gave a real fixture-based seam, no
 * equivalent exists for SimBrief and building one wasn't in scope for a testing-only pass).
 * So this covers what's real, deterministic, and offline: aircraft selection prefilling
 * the form from Fleet data, and the Advanced options dialog — the parts genuinely
 * main-process/IPC-backed rather than already covered by DispatchView's renderer
 * integration test (which mocks window.winglog entirely). The launched app's own Page is
 * bound to `page`, not `window` — see settings.spec.ts's doc comment for why.
 */
test('selecting a fleet aircraft prefills the plan, and the Advanced dialog opens/closes', async () => {
  const { window: page, cleanup } = await launchApp()
  try {
    // Seed one fleet aircraft with a known current location via the real IPC bridge —
    // Fleet's own CRUD flow is covered separately (fleet-crud.spec.ts); this just needs
    // an aircraft to exist so Dispatch's own prefill logic has something real to read.
    await page.evaluate(() =>
      window.winglog.aircraftCreate({
        registration: 'G-DISP',
        icaoType: 'A320',
        operator: null,
        operatorIata: null,
        operatorIcao: null,
        simbriefAirframeId: null,
        simbriefType: null,
        currentIcao: 'EGLL'
      })
    )

    await page.getByRole('tab', { name: 'Dispatch' }).click()
    await expect(page.getByRole('heading', { name: 'Dispatch' })).toBeVisible()

    // Selecting the aircraft prefills departure from its currentIcao (DispatchView.tsx's
    // handlePlanAircraftChange).
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /G-DISP/ }).click()
    await expect(page.getByText('EGLL', { exact: true }).first()).toBeVisible()

    // Advanced dialog opens and closes without touching anything network-dependent.
    await page.getByRole('button', { name: /Advanced/ }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  } finally {
    await cleanup()
  }
})
