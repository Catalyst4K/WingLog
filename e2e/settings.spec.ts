import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Settings' real-persistence flows against the real built app, per flightdeck-backend's
 * docs/plans/test-coverage.md Phase 4. Deliberately avoids anything that opens a real OS
 * dialog or external browser window (Import/Export, "Log in with Navigraph", GSX's
 * "Browse…") or hits the network (SimBrief login) — those aren't drivable headlessly and
 * are covered at the unit/renderer layer instead. Cloud sync isn't built with
 * WINGLOG_CLOUD_SYNC=1 here, so that card doesn't render at all (public-release-v1.md's
 * build-time flag) — nothing to test against in this build.
 *
 * Unit/theme toggles don't change any visible text (only which button's `variant` is
 * active), so persistence is checked the same way the app itself would notice it: reading
 * straight back through the real `window.winglog` IPC bridge via `evaluate`, not by
 * asserting on Tailwind classes. The launched app's own Page is bound to `page`, not
 * `window` — `page.evaluate(() => window...)` runs inside the browser, where `window` is
 * the real DOM global; naming the outer variable `window` too would only shadow it for
 * TypeScript (Playwright still runs the callback in the browser at runtime either way).
 */
test('changes units, theme, SimBrief username, and GSX settings, all persisted', async () => {
  const { window: page, cleanup } = await launchApp()
  try {
    await page.getByRole('tab', { name: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

    // Units — Weights defaults to lb (App.tsx's initial state)
    expect(await page.evaluate(() => window.winglog.settingsGetWeightUnit())).toBe('lb')
    await page.getByRole('button', { name: 'kg', exact: true }).click()
    expect(await page.evaluate(() => window.winglog.settingsGetWeightUnit())).toBe('kg')

    // Theme
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    expect(await page.evaluate(() => window.winglog.settingsGetTheme())).toBe('dark')
    await expect(page.locator('html')).toHaveClass(/dark/)

    // SimBrief username, 3rd-party tab
    await page.getByRole('tab', { name: '3rd party' }).click()
    await page.getByPlaceholder('Navigraph Alias').fill('e2e-test-pilot')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('SimBrief username saved.')).toBeVisible()
    expect(await page.evaluate(() => window.winglog.settingsGetSimbriefUsername())).toBe('e2e-test-pilot')

    // GSX — the auto-enable-on-first-launch check (first-launch-check.ts) may already have
    // flipped this on if this machine's real APPDATA\Virtuali\GSX\Receipts exists, so assert
    // the toggle flips state rather than assuming a fixed starting value.
    const initiallyEnabled = (await page.evaluate(() => window.winglog.settingsGetGsx())).enabled
    await page.getByRole('button', { name: initiallyEnabled ? 'On' : 'Off', exact: true }).click()
    await expect(page.getByRole('button', { name: initiallyEnabled ? 'Off' : 'On', exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.winglog.settingsGetGsx())).enabled).toBe(!initiallyEnabled)
  } finally {
    await cleanup()
  }
})
