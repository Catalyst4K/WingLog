import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

/**
 * Launches the real built app (`npm run build`'s `out/`) against a fresh, isolated
 * `--user-data-dir` — never the real developer profile. Confirmed live (winglog-backend's
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
   *  to drive main/index.ts's replay seam (WINGLOG_E2E_FIXTURE and friends — winglog-
   *  backend's docs/plans/flight-replay-harness.md Phase 3) without a live sim. */
  env?: Record<string, string>
  /** Use this directory as `--user-data-dir` instead of a freshly created empty one — for
   *  a test that needs to launch against a pre-seeded `winglog.db` (see
   *  src/main/tracking/seed-e2e-completed-flight.test.ts) rather than an empty database.
   *  Still isolated, still the caller's responsibility to have created it and to clean it
   *  up (cleanup() below only removes a directory it created itself). */
  userDataDir?: string
  /** Leave the first-launch setup open (winglog-backend's docs/plans/first-launch-setup.md)
   *  for a test about the setup itself. By default it's closed straight away, since every
   *  other test starts from a fresh profile and would otherwise find it in the way. */
  keepSetup?: boolean
}

/**
 * A port nothing listens on: bound and released at once.
 *
 * @returns The port.
 */
async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/** How long to wait for the app to close before killing it. */
const CLOSE_TIMEOUT_MS = 10_000

/**
 * Keeps the app's main.log in `test-results/` when it records an uncaught exception, before the isolated profile is deleted: a
 * flake in which the main process threw (`timer._onTimeout is not a function`, one launch in about 80 under load)
 * otherwise leaves nothing to read.
 *
 * @param userDataDir The profile the app ran in.
 */
function keepErrorLog(userDataDir: string): void {
  const log = join(userDataDir, 'logs', 'main.log')
  if (!existsSync(log) || !/Uncaught|TypeError|ReferenceError/.test(readFileSync(log, 'utf8'))) return
  const dir = join(process.cwd(), 'test-results')
  mkdirSync(dir, { recursive: true })
  copyFileSync(log, join(dir, `main-log-${Date.now()}.log`))
}

export async function launchApp(options: LaunchAppOptions = {}): Promise<LaunchedApp> {
  const projectRoot = process.cwd()
  const ownedUserDataDir = options.userDataDir === undefined
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'winglog-e2e-'))

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  // Headless CI's xvfb display has no real GPU — main/index.ts's matching check switches
  // to a software WebGL2 implementation when this is set, avoiding a real crash confirmed
  // live in Logbook's e2e test (FlightMap's maplibre-gl map failing to get a GPU context,
  // then crashing the renderer on unmount). Always on for every e2e launch, real or local —
  // never set anywhere real usage runs, so it can't affect a real user.
  env.WINGLOG_E2E_SOFTWARE_GL = '1'
  // The update check (updates/update-check.ts) asks GitHub 30 s after launch. Point it at a
  // closed local port so no e2e run ever reaches the real API; updates.spec.ts overrides
  // this with its own fake release server. Only honoured by an unpackaged build.
  env.WINGLOG_UPDATE_URL = 'http://127.0.0.1:9/releases/latest'
  // A test run never reaches the real sim or BeyondATC on this machine, whether or not they are running: each is pointed at a port of
  // its own that nothing listens on, which a test's fake server (FakeBeyondAtcServer's env) or replay replaces.
  env.WINGLOG_E2E_SIMCONNECT_PORT = String(await unusedPort())
  env.WINGLOG_E2E_BEYONDATC_PORT = String(await unusedPort())
  // Likewise the VATSIM and IVAO feeds: a closed port, replaced by network-feed-server.ts in a test about them.
  env.WINGLOG_E2E_VATSIM_URL = `http://127.0.0.1:${await unusedPort()}/vatsim`
  env.WINGLOG_E2E_IVAO_URL = `http://127.0.0.1:${await unusedPort()}/ivao`
  // And the METARs the weather panel reads: a closed port, replaced by a test's own fake server.
  env.WINGLOG_E2E_METAR_URL = `http://127.0.0.1:${await unusedPort()}/metar`
  // And the community releases the ATC areas update themselves from (GitHub's): a closed port, replaced by atc-areas-release-server.ts.
  env.WINGLOG_E2E_ATC_AREAS_URL = `http://127.0.0.1:${await unusedPort()}`
  // And the sim's navigation data, read from disk: an empty folder instead of this machine's own Navigraph install, so a run is the same
  // everywhere. navdata-cycle.spec.ts fills it.
  env.WINGLOG_E2E_MSFS_DIR = join(userDataDir, 'fake-msfs')
  // The window is shown without taking the keyboard focus, on a second display when there is one, so a run doesn't interrupt other
  // work. Set WINGLOG_E2E_WINDOW=normal to watch a run like a normal launch, or hidden to show nothing; WINGLOG_E2E_DISPLAY picks a display.
  env.WINGLOG_E2E_WINDOW = process.env.WINGLOG_E2E_WINDOW ?? 'inactive'
  // Closing asks first while a flight is tracked (main/window/CloseGuard.ts); a test that ends with a flight still running has no one to answer.
  env.WINGLOG_E2E_NO_CLOSE_PROMPT = '1'
  Object.assign(env, options.env)

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  if (!options.keepSetup) {
    // Asking is side-effect free for a new install, and the app has already asked (and so
    // already settled an upgraded profile) by the time this runs.
    const setup = await window.evaluate(() => (globalThis as unknown as Window).winglog.setupGetState())
    if (setup.show) {
      await window.getByRole('dialog', { name: 'Welcome to WingLog' }).waitFor()
      await window.keyboard.press('Escape')
      await window.getByRole('dialog').waitFor({ state: 'hidden' })
    }
  }

  return {
    app,
    window,
    cleanup: async () => {
      // An error dialog in the app's main process (an uncaught exception) blocks it, and with it app.close(): don't hang the test on it.
      const closed = await Promise.race([
        app.close().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS))
      ])
      if (!closed) app.process().kill()
      keepErrorLog(userDataDir)
      if (ownedUserDataDir) rmSync(userDataDir, { recursive: true, force: true })
    }
  }
}
