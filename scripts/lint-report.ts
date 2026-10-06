/**
 * `npm run lint:report`: the coding standards' warnings counted per rule and per area, the audit's
 * baseline and progress measure (winglog-backend docs/plans/robustness/code-standards-audit.md,
 * phase 1). Reads ESLint's JSON output and writes release/lint/summary.md.
 *
 *   npm run lint:report            (runs ESLint, then this)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { summarise, type LintFileResult } from './lint-summary'

const dir = join(process.cwd(), 'release', 'lint')
const results = JSON.parse(readFileSync(join(dir, 'eslint.json'), 'utf8')) as LintFileResult[]
const files = results.map((r) => ({ ...r, filePath: relative(process.cwd(), r.filePath).split(sep).join('/') }))
const summary = summarise(files)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'summary.md'), summary)
process.stdout.write(summary)
