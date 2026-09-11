import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Two projects: 'unit' is the original main-process/shared/pure-logic suite (node
// environment, .test.ts only); 'renderer' is real React component/integration tests (jsdom,
// .test.tsx) added for docs/plans/test-coverage.md (flightdeck-backend) — kept separate
// rather than one shared config because jsdom has real per-test overhead a hundred pure
// main-process tests shouldn't pay, and because a renderer test needs setupFiles
// (@testing-library/jest-dom matchers) the unit suite has no use for.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.tsx'],
          setupFiles: ['./vitest.setup.renderer.ts']
        }
      }
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // Wiring/vendored, not business logic — see docs/plans/test-coverage.md
      // (flightdeck-backend) for why each of these is excluded rather than tested:
      // Electron bootstrap and preload have no logic of their own to unit-test (every real
      // effect they trigger is covered by the Playwright acceptance suite instead); the
      // renderer's own entrypoint is React bootstrap; components/ui/** is vendored shadcn,
      // not authored in this repo.
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/main/index.ts',
        'src/preload/index.ts',
        'src/renderer/src/main.tsx',
        'src/renderer/src/components/ui/**'
      ],
      // A ratchet, not the end goal — flightdeck-backend's docs/plans/test-coverage.md
      // targets 100% (of business logic; see the `exclude` list above), but setting that
      // as the enforced threshold before the work to get there is done would break `npm
      // test` for every unrelated change in the meantime. Raise these numbers at the end
      // of each phase as real coverage improves (never lower them to make a red build
      // green) until they reach 100 in the final phase. Phase 1 baseline, 2026-09-11:
      // 49.64/40.85/39.19/50.72. Raised after Phase 2 (main-process gaps closed — every
      // previously-0% module covered, sync-engine.ts to 100%), same day: 56.65/47.13/
      // 45.52/57.88 — floored below that so a one-line nondeterministic dip doesn't flip
      // this red on an unrelated PR.
      thresholds: {
        statements: 56,
        branches: 47,
        functions: 45,
        lines: 57
      }
    }
  }
})
