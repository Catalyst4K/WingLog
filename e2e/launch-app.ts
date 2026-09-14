import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

/**
 * Launches the real built app (`npm run build`'s `out/`) against a fresh, isolated
 * `--user-data-dir` — never the real developer profile. Confirmed live (flightdeck-backend's
 * docs/plans/test-coverage.md) before this existed:
 *
 * - The first arg must be the project ROOT directory (containing package.json, whose
 *   `main` points at `out/main/index.js`), not the entry script path directly — passing
 *   the script path made Electron resolve `app.getAppPath()` to `out/main` instead of the
 *   project root, which broke `migrateDb`'s drizzle-folder lookup (a real "can't find
 *   meta/_journal.json" crash).
 * - `--user-data-dir` genuinely isolates the app: confirmed the real production
 *   `winglog.db`'s mtime is untouched by a spike run, and a fresh db is created inside the
 *   isolated directory instead.
 * - The caller's environment must NOT have `ELECTRON_RUN_AS_NODE` set — if it leaks in
 *   (this project's own `npm test`/`db:migrate` scripts set it inline for better-sqlite3's
 *   ABI, and it can survive in a long-lived shell), Electron launches as plain Node with no
 *   Chromium/BrowserWindow support, and every one of its own switches fails to parse
 *   (`bad option: --remote-debugging-port=0`). Deleting it here rather than trusting the
 *   ambient shell.
 */
export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  /** Call in an `afterEach`/`finally` — closes the app and removes the isolated profile. */
  cleanup: () => Promise<void>
}

export interface LaunchAppOptions {
  /** Extra env vars for this launch only — merged over the inherited environment, never
   *  mutating process.env, so concurrent tests can request different fixtures safely. Used
   *  to drive main/index.ts's replay seam (WINGLOG_E2E_FIXTURE and friends — flightdeck-
   *  backend's docs/plans/flight-replay-harness.md Phase 3) without a live sim. */
  env?: Record<string, string>
  /** Use this directory as `--user-data-dir` instead of a freshly created empty one — for
   *  a test that needs to launch against a pre-seeded `winglog.db` (see
   *  seed-completed-flight.ts) rather than an empty database. Still isolated, still the
   *  caller's responsibility to have created it and to clean it up (cleanup() below only
   *  removes a directory it created itself). */
  userDataDir?: string
}

export async function launchApp(options: LaunchAppOptions = {}): Promise<LaunchedApp> {
  const projectRoot = process.cwd()
  const ownedUserDataDir = options.userDataDir === undefined
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'winglog-e2e-'))

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  Object.assign(env, options.env)

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  return {
    app,
    window,
    cleanup: async () => {
      await app.close()
      if (ownedUserDataDir) rmSync(userDataDir, { recursive: true, force: true })
    }
  }
}
