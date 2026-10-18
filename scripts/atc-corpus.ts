/**
 * `npm run atc-corpus`: every ATC line on this machine run through WingLog's readers, to find lines that look like a clearance
 * that nothing understood (winglog-backend docs/plans/robustness/scenario-testing.md Part 4). Reads BeyondATC's Player logs and
 * any dev-build captures, read-only, and writes release/atc-corpus/report.md (gitignored). Not part of `npm test`.
 *
 *   npm run atc-corpus                       (this machine's BeyondATC logs and WingLog captures)
 *   npm run atc-corpus -- --logs <dir> --captures <dir>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  atcLinesFromCapture,
  formatSummary,
  instructionLinesFromPlayerLog,
  summarise,
  type CorpusLine
} from './atc-corpus-lib'

/**
 * @param flag A flag such as `--logs`.
 * @returns The value after it, or undefined.
 */
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const logsDir =
  argValue('--logs') ?? join(homedir(), 'AppData', 'LocalLow', 'Skirmish Mode Games, Inc', 'BeyondATC')
const capturesDirs = [
  argValue('--captures') ?? join(homedir(), 'AppData', 'Roaming', 'WingLog', 'captures'),
  join(homedir(), 'AppData', 'Roaming', 'WingLog Dev', 'captures')
]

const lines: CorpusLine[] = []
if (existsSync(logsDir)) {
  for (const name of readdirSync(logsDir).filter((f) => /^Player.*\.log$/i.test(f))) {
    lines.push(...instructionLinesFromPlayerLog(readFileSync(join(logsDir, name), 'utf8'), name))
  }
}
for (const dir of capturesDirs) {
  for (const sub of [dir, join(dir, 'kept')]) {
    if (!existsSync(sub)) continue
    for (const name of readdirSync(sub).filter((f) => f.endsWith('.ndjson'))) {
      lines.push(...atcLinesFromCapture(readFileSync(join(sub, name), 'utf8'), name))
    }
  }
}

const report = formatSummary(summarise(lines))
const outDir = join(process.cwd(), 'release', 'atc-corpus')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'report.md'), report)
process.stdout.write(report)
