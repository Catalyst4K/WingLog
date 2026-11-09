/**
 * `npm run perf:host`: what the sim PC's WingLog costs while it tracks a replayed flight, with its window shown, hidden in the tray, hidden with
 * another WingLog connected, and with no window at all (winglog-backend's docs/plans/multi-device.md, R1 step 1). It reads Electron's own
 * per-process figures (`app.getAppMetrics()`): CPU as a percentage of one core, memory as working set; and Windows' GPU counters for the app's
 * processes: graphics-card engine use and video memory. `npm run perf:host -- growth` instead replays the flight fast and reads memory every
 * 10 s, shown against hidden, to see what grows over a long flight. Needs a multi-device build
 * (`WINGLOG_MULTI_DEVICE=1 npx electron-vite build && npm run build:lan`) and no MSFS running. Maps are drawn on the real GPU, as in a normal
 * launch. Writes release/perf/host-resources.md or host-growth.md (gitignored).
 *
 * "No window" destroys the main window after opening a blank one to stop the app quitting: that blank window is a small renderer of its own, so
 * the saving shown is slightly understated. The sim is replayed from a recorded flight, so telemetry arrives at the rate it does in flight.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { launchApp } from './launch-app'
import { freePort } from './lan-device'

const SETTLE_MS = 8_000
const SAMPLE_SECONDS = 30
/** `growth` can be made longer and slower: WINGLOG_PERF_SPEED (replay speed), WINGLOG_PERF_READINGS and WINGLOG_PERF_INTERVAL_S. */
const GROWTH_SPEED = process.env.WINGLOG_PERF_SPEED ?? '30'
const GROWTH_READINGS = Number(process.env.WINGLOG_PERF_READINGS ?? 14)
const GROWTH_INTERVAL_S = Number(process.env.WINGLOG_PERF_INTERVAL_S ?? 10)

/** What the graphics card reports for the app's processes (Windows performance counters). */
interface Gpu {
  /** Engine utilisation, summed over the app's processes, percent. */
  utilPct: number
  /** Video memory the app holds on the card, MB. */
  dedicatedMb: number
  /** System memory the app has shared with the card, MB. */
  sharedMb: number
}

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
  gpu: Gpu | null
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
 * @returns The process ids of every process the app has.
 */
async function pidsOf(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((m) => m.pid))
}

/** The PowerShell that averages Windows' GPU counters for some processes over a number of seconds (one read, one sample a second). */
function gpuScript(pids: number[], seconds: number): string {
  return [
    `$pids = @(${pids.join(',')})`,
    String.raw`$counters = @('\GPU Engine(*)\Utilization Percentage', '\GPU Process Memory(*)\Dedicated Usage', '\GPU Process Memory(*)\Shared Usage')`,
    `$sets = Get-Counter -Counter $counters -SampleInterval 1 -MaxSamples ${seconds} -ErrorAction SilentlyContinue`,
    '$u = @(); $d = @(); $h = @()',
    'foreach ($set in $sets) {',
    String.raw`  $mine = $set.CounterSamples | Where-Object { $_.InstanceName -match 'pid_(\d+)_' -and ($pids -contains [int]$Matches[1]) }`,
    "  $u += ($mine | Where-Object { $_.Path -like '*utilization percentage' } | Measure-Object CookedValue -Sum).Sum",
    "  $d += ($mine | Where-Object { $_.Path -like '*dedicated usage' } | Measure-Object CookedValue -Sum).Sum",
    "  $h += ($mine | Where-Object { $_.Path -like '*shared usage' } | Measure-Object CookedValue -Sum).Sum",
    '}',
    '$avg = { param($a) if ($a.Count -eq 0) { 0 } else { ($a | Measure-Object -Average).Average } }',
    '@{ utilPct = (& $avg $u); dedicatedMb = ((& $avg $d) / 1MB); sharedMb = ((& $avg $h) / 1MB) } | ConvertTo-Json -Compress'
  ].join('\n')
}

/**
 * @param pids The processes.
 * @param seconds How long to sample.
 * @returns The averages, or null when the counters cannot be read (not Windows, or no GPU counters).
 */
function sampleGpu(pids: number[], seconds: number): Promise<Gpu | null> {
  // A script file, not -Command: nothing in it then depends on how the command line is quoted.
  const dir = mkdtempSync(join(tmpdir(), 'winglog-perf-gpu-'))
  const file = join(dir, 'gpu.ps1')
  writeFileSync(file, gpuScript(pids, seconds))
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { timeout: (seconds + 60) * 1000 },
      (error, stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true })
        try {
          resolve(JSON.parse(stdout.trim()) as Gpu)
        } catch {
          console.error(
            'GPU counters unavailable:',
            error?.message ?? '',
            stdout.slice(0, 200),
            stderr.slice(0, 300)
          )
          resolve(null)
        }
      }
    )
  })
}

/**
 * @param app The running app.
 * @param state The name of the state being measured.
 * @returns The average over the sample of each kind of process, after the state has settled.
 */
async function measure(app: ElectronApplication, state: string): Promise<Result> {
  await sleep(SETTLE_MS)
  await read(app)
  const gpuSampling = sampleGpu(await pidsOf(app), SAMPLE_SECONDS)
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
  return {
    state,
    cpu,
    memMb,
    cpuTotal: total(cpu),
    memTotalMb: total(memMb),
    gpu: await gpuSampling
  }
}

/**
 * @param results The measured states.
 * @returns A markdown report.
 */
function report(results: Result[]): string {
  const types = [...new Set(results.flatMap((r) => Object.keys(r.cpu)))].sort()
  const fmt = (n: number | undefined): string => (n === undefined ? '-' : n.toFixed(1))
  const dashes = (n: number): string => '---|'.repeat(n)
  const lines = [
    '# Sim PC WingLog: resources while tracking a replayed flight',
    '',
    `Each state: ${SETTLE_MS / 1000} s to settle, then the average over ${SAMPLE_SECONDS} s. CPU is percent of one core; memory is working set in MB; GPU is the graphics card's engine use (percent), video memory and shared memory for the app's processes.`,
    '',
    `| State | CPU total | ${types.map((t) => `CPU ${t}`).join(' | ')} | Memory total | ${types.map((t) => `MB ${t}`).join(' | ')} | GPU engine % | GPU video MB | GPU shared MB |`,
    `|---|---|${dashes(types.length)}---|${dashes(types.length)}---|---|---|`
  ]
  for (const r of results) {
    lines.push(
      `| ${r.state} | ${fmt(r.cpuTotal)} | ${types.map((t) => fmt(r.cpu[t])).join(' | ')} | ${fmt(r.memTotalMb)} | ${types.map((t) => fmt(r.memMb[t])).join(' | ')} | ${fmt(r.gpu?.utilPct)} | ${fmt(r.gpu?.dedicatedMb)} | ${fmt(r.gpu?.sharedMb)} |`
    )
  }
  return lines.join('\n') + '\n'
}

/**
 * How memory grows over a long flight: the recorded flight replayed fast (a point is what grows, not a second), once with the window shown and
 * once hidden, memory read every 10 s.
 *
 * @returns A markdown report.
 */
async function growth(): Promise<string> {
  const fixture = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')
  const lines = [
    `# Sim PC WingLog: memory over a long flight (the recorded flight replayed at ${GROWTH_SPEED}x)`,
    ''
  ]
  for (const hidden of [false, true]) {
    const host = await launchApp({
      env: {
        WINGLOG_E2E_SOFTWARE_GL: '',
        WINGLOG_E2E_FIXTURE: fixture,
        WINGLOG_E2E_REPLAY_MODE: 'paced',
        WINGLOG_E2E_REPLAY_SPEED: GROWTH_SPEED
      }
    })
    try {
      await host.window.evaluate(async () => {
        const api = window.winglog
        const aircraft = await api.aircraftCreate({ registration: 'G-GROW', icaoType: 'A320' })
        await api.trackingStartFree({
          aircraftId: aircraft.id,
          simRegistration: null,
          simIcaoType: null,
          depIcao: 'EGLL',
          arrIcao: 'EGCC',
          flightNumber: 'GROW1'
        })
      })
      await host.window.getByRole('tab', { name: 'Track' }).click()
      if (hidden) await host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
      await sleep(5_000)
      lines.push(
        `## Window ${hidden ? 'hidden' : 'shown'}`,
        '',
        '| Seconds | Track points | Total MB | Main process MB | Window (renderer) MB | Graphics process MB |',
        '|---|---|---|---|---|---|'
      )
      for (let i = 0; i < GROWTH_READINGS; i++) {
        const reading = await read(host.app)
        const points = await host.window
          .evaluate(async () => {
            const active = await window.winglog.trackingGetActive()
            return active ? (await window.winglog.trackPointList(active.flightId)).length : 0
          })
          .catch(() => 0)
        const total = Object.values(reading.memMb).reduce((a, b) => a + b, 0)
        lines.push(
          `| ${i * GROWTH_INTERVAL_S} | ${points} | ${total.toFixed(0)} | ${(reading.memMb.Browser ?? 0).toFixed(0)} | ${(reading.memMb.Tab ?? 0).toFixed(0)} | ${(reading.memMb.GPU ?? 0).toFixed(0)} |`
        )
        await sleep(GROWTH_INTERVAL_S * 1000)
      }
      lines.push('')
    } finally {
      await host.cleanup()
    }
  }
  return lines.join('\n') + '\n'
}

/** Runs the states measurement. */
async function states(): Promise<string> {
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
  return report(results)
}

/** Runs the measurement asked for. */
async function main(): Promise<void> {
  const grow = process.argv.includes('growth')
  const out = grow ? await growth() : await states()
  console.log(out)
  mkdirSync(join(process.cwd(), 'release', 'perf'), { recursive: true })
  writeFileSync(join(process.cwd(), 'release', 'perf', grow ? 'host-growth.md' : 'host-resources.md'), out)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
