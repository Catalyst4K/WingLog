import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// `npm run sim -- <feature>`: runs scripts/sim/<feature>.sim.ts under vitest, so the app's own
// modules load exactly as in the tests (Vite's `?raw` imports, the path aliases, the build
// flags). Separate from vitest.config.ts: these read local data and never run in `npm test`.
export default defineConfig({
  root: resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../../src/shared'),
      '@renderer': resolve(__dirname, '../../src/renderer/src'),
      '@': resolve(__dirname, '../../src/renderer/src')
    }
  },
  define: {
    __WINGLOG_CLOUD_SYNC_ENABLED__: JSON.stringify(false),
    __WINGLOG_DEV_BUILD__: JSON.stringify(false)
  },
  test: {
    environment: 'node',
    include: ['scripts/sim/*.sim.ts'],
    testTimeout: 600_000
  }
})
