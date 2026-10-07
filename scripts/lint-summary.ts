/**
 * Counts ESLint warnings per rule and per area of the codebase, as a Markdown report: the logic of
 * `npm run lint:report` (scripts/lint-report.ts), kept apart so it's testable.
 */

/** One file of ESLint's JSON formatter output, as much of it as the report reads. */
export interface LintFileResult {
  /** Repo-relative, forward slashes. */
  filePath: string
  messages: { ruleId: string | null; severity: number; message?: string }[]
}

/**
 * The area a file belongs to, as the audit's phase 3 works through them: a main-process folder,
 * the renderer's hooks or views, shared code.
 */
export function areaOf(filePath: string): string {
  const parts = filePath.split('/')
  if (parts[0] !== 'src') return parts[0] ?? filePath
  if (parts[1] === 'main') return parts.length > 3 ? `main/${parts[2]}` : 'main (root)'
  if (parts[1] === 'renderer') {
    const file = parts.at(-1) ?? ''
    if (parts.length > 4) return `renderer/${parts[3]}`
    return file.endsWith('.tsx') ? 'renderer views' : 'renderer modules'
  }
  return parts[1] ?? filePath
}

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`)
  ].join('\n')
}

/** The report: totals per rule, then per area with each area's rules. Errors are counted apart. */
export function summarise(results: LintFileResult[]): string {
  const byRule = new Map<string, number>()
  const byArea = new Map<string, Map<string, number>>()
  let errors = 0
  for (const file of results) {
    for (const message of file.messages) {
      if (message.severity === 2) errors++
      const rule =
        message.ruleId ??
        (message.message?.startsWith('Unused eslint-disable') ? '(unused eslint-disable)' : '(parse error)')
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1)
      const area = areaOf(file.filePath)
      const rules = byArea.get(area) ?? new Map<string, number>()
      rules.set(rule, (rules.get(rule) ?? 0) + 1)
      byArea.set(area, rules)
    }
  }
  const total = [...byRule.values()].reduce((a, b) => a + b, 0)
  const sortDesc = (m: Map<string, number>): [string, number][] =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const areaRows = [...byArea.entries()]
    .map(([area, rules]) => ({ area, rules, count: [...rules.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area))
    .map(({ area, rules, count }) => [
      area,
      String(count),
      sortDesc(rules)
        .map(([r, n]) => `${r} ${n}`)
        .join(', ')
    ])
  return [
    '# Lint report',
    '',
    `${total} findings in ${results.filter((r) => r.messages.length > 0).length} files (${errors} errors).`,
    '',
    '## By rule',
    '',
    table(
      ['Rule', 'Count'],
      sortDesc(byRule).map(([r, n]) => [r, String(n)])
    ),
    '',
    '## By area',
    '',
    table(['Area', 'Count', 'Rules'], areaRows),
    ''
  ].join('\n')
}
