/**
 * `npm run perf:sync`: how long the app stands still while it syncs (winglog-backend's docs/plans/multi-device.md, finding F11). Two real apps
 * on loopback: a host holding a copy of this machine's real logbook and a fresh client that pairs and does its first sync, which is the biggest
 * sync there is. A probe in the client's main process reports how late a 20 ms timer fires; a late timer is a moment nothing else, the window
 * included, could run. Needs a multi-device build (`WINGLOG_MULTI_DEVICE=1 npx electron-vite build && npm run build:lan`), no MSFS running and
 * a real logbook at %APPDATA%/WingLog/winglog.db (the copy is deleted afterwards). Writes release/perf/sync-stalls.md (gitignored).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './launch-app'
import { freePort } from './lan-device'

const REAL_DB = join(process.env.APPDATA ?? '', 'WingLog', 'winglog.db')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** What the probe in a main process counted. */
interface Stalls {
  maxMs: number
  over50: number
  over100: number
  over250: number
  totalOver100Ms: number
}

/** Runs the measurement. */
async function main(): Promise<void> {
  if (!existsSync(REAL_DB)) {
    console.log('No real logbook at', REAL_DB, '- nothing to measure.')
    return
  }
  const clientDir = mkdtempSync(join(tmpdir(), 'winglog-perf-client-'))
  const hostDir = mkdtempSync(join(tmpdir(), 'winglog-perf-host-'))
  copyFileSync(REAL_DB, join(hostDir, 'winglog.db'))
  const port = await freePort()
  const started = Date.now()
  const seconds = (): string => ((Date.now() - started) / 1000).toFixed(1)
  const lines: string[] = ['# Main-thread stalls during a first sync with a copy of the real logbook', '']
  try {
    const setup = await launchApp({ userDataDir: clientDir })
    await setup.window.evaluate(() => window.winglog.settingsSetRunMode('client'))
    await setup.cleanup()
    const host = await launchApp({ userDataDir: hostDir, env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      const code = await host.window.evaluate(async (lanPort) => {
        await window.winglog.lanSetSettings({ twinEnabled: true, port: lanPort })
        return (await window.winglog.lanStartPairing('twin')).twinPairing?.code ?? ''
      }, port)
      // The probe is also run in the host's main process: it serves the pages.
      for (const app of [host.app]) {
        await app.evaluate(() => {
          const g = globalThis as unknown as { __stalls: Record<string, number> }
          g.__stalls = { maxMs: 0, over50: 0, over100: 0, over250: 0, totalOver100Ms: 0 }
          ;(g as unknown as { __list: number[][] }).__list = []
          let last = Date.now()
          setInterval(() => {
            const now = Date.now()
            const late = now - last - 20
            last = now
            const s = g.__stalls
            if (late > s.maxMs) s.maxMs = late
            if (late > 50) s.over50 += 1
            if (late > 100) {
              s.over100 += 1
              s.totalOver100Ms += late
            }
            if (late > 250) s.over250 += 1
            if (late > 100) (g as unknown as { __list: number[][] }).__list.push([now, late])
          }, 20).unref()
        })
      }
      const client = await launchApp({ userDataDir: clientDir })
      try {
        await client.app.evaluate(() => {
          const g = globalThis as unknown as { __stalls: Record<string, number> }
          g.__stalls = { maxMs: 0, over50: 0, over100: 0, over250: 0, totalOver100Ms: 0 }
          ;(g as unknown as { __list: number[][] }).__list = []
          let last = Date.now()
          setInterval(() => {
            const now = Date.now()
            const late = now - last - 20
            last = now
            const s = g.__stalls
            if (late > s.maxMs) s.maxMs = late
            if (late > 50) s.over50 += 1
            if (late > 100) {
              s.over100 += 1
              s.totalOver100Ms += late
            }
            if (late > 250) s.over250 += 1
            if (late > 100) (g as unknown as { __list: number[][] }).__list.push([now, late])
          }, 20).unref()
        })
        await client.window.evaluate(([a, c]) => window.winglog.hostLinkPair(a, c), [
          `127.0.0.1:${port}`,
          code
        ] as const)
        await client.window.getByText('Sim PC: connected').waitFor({ timeout: 30_000 })
        const connectedAt = Date.now()
        for (let i = 0; i < 400; i++) {
          const status = await client.window.evaluate(() => window.winglog.hostLinkGetStatus())
          if (status.sync.lastSyncedAt) break
          await sleep(250)
        }
        const firstSyncSeconds = ((Date.now() - connectedAt) / 1000).toFixed(1)
        // Let the track download that follows the tables finish too.
        await sleep(20_000)
        const clientStalls = await client.app.evaluate(
          () => (globalThis as unknown as { __stalls: Record<string, number> }).__stalls
        )
        const hostStalls = await host.app.evaluate(
          () => (globalThis as unknown as { __stalls: Record<string, number> }).__stalls
        )
        const list = await client.app.evaluate(() => (globalThis as unknown as { __list: number[][] }).__list)
        console.log(
          'Client stalls over 100 ms (seconds after connecting, ms):',
          list.map(([at, late]) => `${((at - connectedAt) / 1000).toFixed(1)}s/${late}`).join('  ')
        )
        const fmt = (s: Stalls): string =>
          `longest ${s.maxMs} ms; stalls over 50 ms: ${s.over50}; over 100 ms: ${s.over100} (${s.totalOver100Ms} ms in all); over 250 ms: ${s.over250}`
        lines.push(
          `First sync (tables) took ${firstSyncSeconds} s after connecting; measured for ${seconds()} s from launch, including the track download that follows.`,
          '',
          `- Client main thread: ${fmt(clientStalls as unknown as Stalls)}`,
          `- Host main thread: ${fmt(hostStalls as unknown as Stalls)}`,
          ''
        )
      } finally {
        await client.cleanup()
      }
    } finally {
      await host.cleanup()
    }
  } finally {
    rmSync(clientDir, { recursive: true, force: true })
    rmSync(hostDir, { recursive: true, force: true })
  }
  const out = lines.join('\n') + '\n'
  console.log(out)
  mkdirSync(join(process.cwd(), 'release', 'perf'), { recursive: true })
  writeFileSync(join(process.cwd(), 'release', 'perf', 'sync-stalls.md'), out)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
