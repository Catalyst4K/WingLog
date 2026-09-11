import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Proves the whole harness end to end before any real flow gets built on top of it: the
 * built app launches against a fresh, isolated profile, migrates its own database, and
 * renders a first screen — same thing `.github/workflows/package.yml`'s WINGLOG_SMOKE_TEST
 * already checks for the packaged binary, but through Playwright so later tests can drive
 * real UI interactions the same way.
 */
test('the app launches, migrates its isolated database, and renders a first screen', async () => {
  const { window, cleanup } = await launchApp()
  try {
    await expect(window).toHaveTitle('WingLog')
    // Fleet is the default landing view (App.tsx) — its own heading proves the renderer
    // actually mounted and rendered real content, not just an empty window.
    await expect(window.getByRole('heading', { name: 'Fleet' })).toBeVisible()
  } finally {
    await cleanup()
  }
})
