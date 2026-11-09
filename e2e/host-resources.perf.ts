/**
 * `npm run perf:host`: what the sim PC's WingLog costs while it tracks a replayed flight, with its window shown, hidden in the tray, hidden with
 * another WingLog connected, and with no window at all (winglog-backend's docs/plans/multi-device.md, R1 step 1). It reads Electron's own
 * per-process figures (`app.getAppMetrics()`): CPU as a percentage of one core, memory as working set. Needs a multi-device build
 * (`WINGLOG_MULTI_DEVICE=1 npx electron-vite build && npm run build:lan`) and no MSFS running. Maps are drawn on the real GPU, as in a normal
 * launch. Writes release/perf/host-resources.md (gitignored).
 *
 * "No window" destroys the main window after opening a blank one to stop the app quitting: that blank window is a small renderer of its own, so
 * the saving shown is slightly understated. The sim is replayed in real time from a recorded flight, so telemetry arrives at the rate it does in flight.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { launchApp } from './launch-app'
import { freePort } from './lan-device'

const SETTLE_MS = 8_000
const SAMPLE_SECONDS = 30

/** One reading of the app's processes. */
interface Reading {
  cpu: Record<string, number>
  memMb: Record<string, number>
}

/** The averaged result for one state. */
interface Result {
  state: string
  cpu: Record<string, number>
  memMb: Record<string, number>
  cpuTotal: number
  memTotalMb: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param app The running app.
 * @returns The CPU (percent of one core since the last reading) and memory of each kind of process, summed.
 */
async function read(app: ElectronApplication): Promise<Reading> {
  const rows = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({
      type: m.type,
      cpu: m.cpu.percentCPUUsage,
      memKb: m.memory.workingSetSize
    }))
  )
  const cpu: Record<string, number> = {}
  const memMb: Record<string, number> = {}
  for (const row of rows) {
    cpu[row.type] = (cpu[row.type] ?? 0) + row.cpu
    memMb[row.type] = (memMb[row.type] ?? 0) + row.memKb / 1024
  }
  return { cpu, memMb }
}

/**
 * @param app The running app.
 * @param state The name of the state being measured.
 * @returns The average over the sample of each kind of process, after the state has settled.
 */
async function measure(app: ElectronApplication, state: string): Promise<Result> {
  await sleep(SETTLE_MS)
  await read(app)
  const readings: Reading[] = []
  for (let i = 0; i < SAMPLE_SECONDS; i++) {
    await sleep(1000)
    readings.push(await read(app))
  }
  const types = new Set(readings.flatMap((r) => Object.keys(r.cpu)))
  const mean = (pick: (r: Reading) => Record<string, number>, type: string): number =>
    readings.reduce((sum, r) => sum + (pick(r)[type] ?? 0), 0) / readings.length
  const cpu: Record<string, number> = {}
  const memMb: Record<string, number> = {}
  for (const type of types) {
    cpu[type] = mean((r) => r.cpu, type)
    memMb[type] = mean((r) => r.memMb, type)
  }
  const total = (values: Record<string, number>): number => Object.values(values).reduce((a, b) => a + b, 0)
  return { state, cpu, memMb, cpuTotal: total(cpu), memTotalMb: total(memMb) }
}

/**
 * @param results The measured states.
 * @returns A markdown report.
 */
function report(results: Result[]): string {
  const types = [...new Set(results.flatMap((r) => Object.keys(r.cpu)))].sort()
  const fmt = (n: number | undefined): string => (n === undefined ? '-' : n.toFixed(1))
  const lines = [
    '# Sim PC WingLog: resources while tracking a replayed flight',
    '',
    `Each state: ${SETTLE_MS / 1000} s to settle, then the average over ${SAMPLE_SECONDS} s. CPU is percent of one core; memory is working set in MB.`,
    '',
    `| State | CPU total | ${types.map((t) => `CPU ${t}`).join(' | ')} | Memory total | ${types.map((t) => `MB ${t}`).join(' | ')} |`,
    `|---|---|${types.map(() => '---|').join('')}---|${types.map(() => '---|').join('')}`
  ]
  for (const r of results) {
    lines.push(
      `| ${r.state} | ${fmt(r.cpuTotal)} | ${types.map((t) => fmt(r.cpu[t])).join(' | ')} | ${fmt(r.memTotalMb)} | ${types.map((t) => fmt(r.memMb[t])).join(' | ')} |`
    )
  }
  return lines.join('\n') + '\n'
}

/** Runs the measurement. */
async function main(): Promise<void> {
  const fixture = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')
  const clientDir = mkdtempSync(join(tmpdir(), 'winglog-perf-client-'))
  const port = await freePort()
  const results: Result[] = []
  const host = await launchApp({
    env: {
      WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1',
      WINGLOG_E2E_SOFTWARE_GL: '',
      WINGLOG_E2E_FIXTURE: fixture,
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: '1'
    }
  })
  try {
    const capabilities = await host.window.evaluate(() => window.winglog.appGetCapabilities())
    // The host tracks a flight, with the Track tab (and its map) in front: the heaviest screen.
    await host.window.evaluate(async () => {
      const api = window.winglog
      const aircraft = await api.aircraftCreate({ registration: 'G-PERF', icaoType: 'A320' })
      await api.trackingStartFree({
        aircraftId: aircraft.id,
        simRegistration: null,
        simIcaoType: null,
        depIcao: 'EGLL',
        arrIcao: 'EGCC',
        flightNumber: 'PERF1'
      })
    })
    await host.window.getByRole('tab', { name: 'Track' }).click()
    results.push(await measure(host.app, '1. Window shown (Track tab, map drawn)'))

    await host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
    results.push(await measure(host.app, '2. Window hidden in the tray'))

    if (capabilities.multiDevice) {
      const setup = await launchApp({ userDataDir: clientDir })
      await setup.window.evaluate(() => window.winglog.settingsSetRunMode('client'))
      await setup.cleanup()
      const code = await host.window.evaluate(async (lanPort) => {
        await window.winglog.lanSetSettings({ twinEnabled: true, port: lanPort })
        return (await window.winglog.lanStartPairing('twin')).twinPairing?.code ?? ''
      }, port)
      const client = await launchApp({ userDataDir: clientDir })
      try {
        await client.window.evaluate(([a, c]) => window.winglog.hostLinkPair(a, c), [
          `127.0.0.1:${port}`,
          code
        ] as const)
        await client.window.getByText('Sim PC: connected').waitFor({ timeout: 20_000 })
        await client.window.getByRole('tab', { name: 'Track' }).click()
        results.push(await measure(host.app, '3. Window hidden, another WingLog connected and following'))

        await host.app.evaluate(({ BrowserWindow }) => {
          // A blank window first, so closing the main one does not quit the app.
          const keep = new BrowserWindow({ show: false })
          void keep.loadURL('about:blank')
          BrowserWindow.getAllWindows()
            .filter((w) => w !== keep)
            .forEach((w) => w.destroy())
        })
        results.push(await measure(host.app, '4. No window, another WingLog connected and following'))
      } finally {
        await client.cleanup()
      }
    }
  } finally {
    await host.cleanup()
    rmSync(clientDir, { recursive: true, force: true })
  }
  const out = report(results)
  console.log(out)
  mkdirSync(join(process.cwd(), 'release', 'perf'), { recursive: true })
  writeFileSync(join(process.cwd(), 'release', 'perf', 'host-resources.md'), out)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
