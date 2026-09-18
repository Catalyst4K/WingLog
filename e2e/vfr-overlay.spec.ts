import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * The Track map's VFR overlay (flightdeck-backend docs/plans/map-language-and-declutter.md,
 * Part C) through the real built app — the unit tests mock MapLibre, so this is the check
 * that the real IPC channel serves the real vendored airfield list and that switching the
 * overlay on and off against a real (software-WebGL) map doesn't throw.
 */
test('the VFR overlay loads the real airfield list and toggles on and off', async () => {
  const { window, cleanup } = await launchApp()
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))
  try {
    await window.getByRole('tab', { name: 'Track' }).click()
    await expect(window.getByRole('heading', { name: 'Track' })).toBeVisible()

    const toggle = window.getByRole('button', { name: /VFR overlay/ })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    // The real channel, real ~43k-row vendored list, with a known large airport in it.
    const summary = await window.evaluate(async () => {
      const api = (
        globalThis as unknown as {
          winglog: { airportListAirfields: () => Promise<{ icao: string; type: string }[]> }
        }
      ).winglog
      const list = await api.airportListAirfields()
      return { count: list.length, egll: list.find((a) => a.icao === 'EGLL')?.type ?? null }
    })
    expect(summary.count).toBeGreaterThan(40_000)
    expect(summary.egll).toBe('large_airport')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(pageErrors).toEqual([])
  } finally {
    await cleanup()
  }
})
