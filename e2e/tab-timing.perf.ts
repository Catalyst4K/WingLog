/**
 * `npm run perf:tabs`: how long each tab takes to appear in the real built app, first visit against second, the app clicked
 * straight after launch against after it has settled (winglog-backend docs/plans/robustness/performance-and-storage.md, Part 3).
 * Needs `npm run build` first. With WINGLOG_PERF_REAL_DATA=1 it runs against a copy of this machine's database (the copy is
 * deleted afterwards); otherwise against an empty profile. Writes release/perf/tab-timing.md (gitignored).
 *
 * "Appeared" means the tab's skeleton is gone and the page has stopped changing for 250 ms; the time is from the click to the last
 * change. WebGL is software-rendered here (as in every e2e run), so the map tabs are slower than on a real GPU: compare first
 * with second visit, not against a stopwatch.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { launchApp } from './launch-app'

const TABS = ['Dispatch', 'Track', 'Logbook', 'Settings', 'Fleet']
const SETTLE_MS = 20_000
const RUNS = 3

interface Timing {
  /** Click to the last change on the page, ms. */
  ms: number
  /** Main-thread work in tasks over 50 ms during that time, ms. */
  longTaskMs: number
  longest: number
}

/**
 * Clicks a tab and measures until the page has stopped changing.
 *
 * @param page The app window.
 * @param name The tab's accessible name.
 * @returns How long it took.
 */
async function timeTab(page: Page, name: string): Promise<Timing> {
  // A string, not a function: tsx wraps named functions in a helper that doesn't exist inside the page.
  return page.evaluate(`(async () => {
    const tabName = ${JSON.stringify(name)}
    const tab = [...document.querySelectorAll('[role=tab]')].find((t) => (t.getAttribute('aria-label') || t.textContent.trim()) === tabName)
    if (!tab) throw new Error('no tab ' + tabName)
    const longTasks = []
    const observer = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration)))
    observer.observe({ entryTypes: ['longtask'] })
    const start = performance.now()
    let last = start
    const mutations = new MutationObserver(() => { last = performance.now() })
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true })
    tab.click()
    await new Promise((resolve) => {
      const check = () => {
        const quiet = performance.now() - last > 250
        if (quiet && !document.querySelector('[data-slot=skeleton]')) resolve()
        else setTimeout(check, 25)
      }
      setTimeout(check, 25)
    })
    mutations.disconnect()
    observer.disconnect()
    return { ms: last - start, longTaskMs: longTasks.reduce((a, b) => a + b, 0), longest: Math.max(0, ...longTasks) }
  })()`) as Promise<Timing>
}

/**
 * One launch: visits every tab twice, optionally waiting first for the app to settle.
 *
 * @param settle Whether to wait SETTLE_MS before the first click.
 * @param userDataDir A profile to launch against, or undefined for a fresh one.
 * @returns The first and second visit of each tab.
 */
async function oneLaunch(settle: boolean, userDataDir?: string): Promise<Record<string, [Timing, Timing]>> {
  const { window, cleanup } = await launchApp({ userDataDir })
  try {
    await window.waitForSelector('[role=tab]')
    if (settle) await window.waitForTimeout(SETTLE_MS)
    else await window.waitForTimeout(1500)
    const first: Record<string, Timing> = {}
    for (const tab of TABS) first[tab] = await timeTab(window, tab)
    const out: Record<string, [Timing, Timing]> = {}
    for (const tab of TABS) out[tab] = [first[tab] as Timing, await timeTab(window, tab)]
    return out
  } finally {
    await cleanup()
  }
}

/** @returns The median of the numbers. */
const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

async function main(): Promise<void> {
  const real = process.env.WINGLOG_PERF_REAL_DATA === '1'
  const lines: string[] = [
    '# Tab timing',
    '',
    `${real ? "A copy of this machine's database" : 'An empty profile'}, ${RUNS} launches each, median. Milliseconds from the click until the page stops changing.`,
    ''
  ]
  for (const settle of [false, true]) {
    const runs: Record<string, [Timing, Timing]>[] = []
    for (let i = 0; i < RUNS; i++) {
      let dir: string | undefined
      if (real) {
        const source = join(process.env.APPDATA ?? '', 'WingLog', 'winglog.db')
        if (!existsSync(source)) throw new Error(`no database at ${source}`)
        dir = mkdtempSync(join(tmpdir(), 'winglog-perf-'))
        copyFileSync(source, join(dir, 'winglog.db'))
      }
      try {
        runs.push(await oneLaunch(settle, dir))
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    }
    lines.push(
      `## ${settle ? `Settled (clicked ${SETTLE_MS / 1000} s after launch)` : 'Cold (clicked 1.5 s after launch)'}`,
      '',
      '| Tab | First visit | Second visit | Long tasks, first | Longest task, first |',
      '|---|---|---|---|---|'
    )
    for (const tab of TABS) {
      const pick = (visit: 0 | 1, key: keyof Timing): number =>
        median(runs.map((r) => (r[tab] as [Timing, Timing])[visit][key]))
      lines.push(
        `| ${tab} | ${pick(0, 'ms').toFixed(0)} | ${pick(1, 'ms').toFixed(0)} | ${pick(0, 'longTaskMs').toFixed(0)} | ${pick(0, 'longest').toFixed(0)} |`
      )
    }
    lines.push('')
  }
  const dir = join(process.cwd(), 'release', 'perf')
  mkdirSync(dir, { recursive: true })
  const report = lines.join('\n') + '\n'
  writeFileSync(join(dir, 'tab-timing.md'), report)
  process.stdout.write(report)
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})
