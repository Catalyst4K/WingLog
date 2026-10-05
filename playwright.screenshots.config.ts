import { defineConfig } from '@playwright/test'

// The manual's screenshot generator (e2e/manual-screenshots.shots.ts), kept out of the normal
// e2e run: it writes files into docs/manual/images. `npm run manual:screenshots`.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.shots.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 300_000
})
