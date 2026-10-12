/**
 * `npm run perf:profile -- Logbook`: a CPU profile of one tab's first visit in the real built app, against a copy of this
 * machine's database (winglog-backend docs/plans/robustness/performance-and-storage.md, Part 3). Where `perf:tabs` says how long a
 * tab takes, this says where the time goes: self time by script and by function. Needs `npm run build` first. The built code is
 * minified, so functions are named by their script and position; the script names say which chunk (and so which feature) it is.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './launch-app'

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }
}
interface Profile {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
}

const SETTLE_MS = 8_000
const TOP = 18

/**
 * @param url A script URL.
 * @returns Its file name, or a label for code with no script.
 */
function scriptName(url: string): string {
  return url ? (url.split('/').pop() ?? url) : '(native or no script)'
}

async function main(): Promise<void> {
  const tab = process.argv[2] ?? 'Logbook'
  const source = join(process.env.APPDATA ?? '', 'WingLog', 'winglog.db')
  if (!existsSync(source)) throw new Error(`no database at ${source}`)
  const dir = mkdtempSync(join(tmpdir(), 'winglog-profile-'))
  copyFileSync(source, join(dir, 'winglog.db'))
  const { window, cleanup } = await launchApp({ userDataDir: dir })
  try {
    await window.waitForSelector('[role=tab]')
    await window.waitForTimeout(SETTLE_MS)
    const session = await window.context().newCDPSession(window)
    await session.send('Profiler.enable')
    await session.send('Profiler.setSamplingInterval', { interval: 200 })
    await session.send('Profiler.start')
    await window.evaluate(`(() => {
      const tab = [...document.querySelectorAll('[role=tab]')].find((t) => (t.getAttribute('aria-label') || t.textContent.trim()) === ${JSON.stringify(tab)})
      tab.click()
    })()`)
    await window.waitForTimeout(3_000)
    const { profile } = (await session.send('Profiler.stop')) as { profile: Profile }

    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const byScript = new Map<string, number>()
    const byFunction = new Map<string, number>()
    let total = 0
    let program = 0
    let idle = 0
    profile.samples.forEach((id, i) => {
      const frame = byId.get(id)?.callFrame
      const ms = (profile.timeDeltas[i] ?? 0) / 1000
      if (frame?.functionName === '(idle)') idle += ms
      if (frame?.functionName === '(program)') program += ms
      if (!frame || frame.functionName === '(idle)' || frame.functionName === '(program)') return
      total += ms
      const script = scriptName(frame.url)
      byScript.set(script, (byScript.get(script) ?? 0) + ms)
      const key = `${frame.functionName || '(anonymous)'} ${script}:${frame.lineNumber}:${frame.columnNumber}`
      byFunction.set(key, (byFunction.get(key) ?? 0) + ms)
    })
    const top = (map: Map<string, number>): string =>
      [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP)
        .map(([name, ms]) => `${ms.toFixed(1).padStart(8)} ms  ${name}`)
        .join('\n')
    process.stdout.write(
      `\n${tab} first visit over 3 s: ${total.toFixed(0)} ms of script, ${program.toFixed(0)} ms of the browser own work (style, layout, paint), ${idle.toFixed(0)} ms idle\n\nBy script:\n${top(byScript)}\n\nBy function:\n${top(byFunction)}\n`
    )
  } finally {
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})
