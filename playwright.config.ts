import { defineConfig } from '@playwright/test'

// Acceptance/integration tests for the real built app (flightdeck-backend's
// docs/plans/test-coverage.md) — drives `out/` via Playwright's Electron support, never the
// dev server, so `npm run build` must run first (same artifact the packaging CI's
// WINGLOG_SMOKE_TEST already exercises). Each test launches its own isolated instance (see
// e2e/launch-app.ts) rather than sharing one across the file, so tests can't leak state
// into each other — an Electron app has no notion of Playwright's usual page-per-test
// isolation on its own.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30_000
})
