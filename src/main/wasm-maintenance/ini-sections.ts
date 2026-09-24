/** Minimal, defensive `[Section]` / `key=value` INI reader shared by every third-party
 *  add-on's maintenance-data adapter (docs/wasm-maintenance-notes.md, flightdeck-backend) —
 *  PMDG's `.hours` files and iniBuilds' `.data` files are both this same shape underneath a
 *  different extension. No add-on-specific knowledge here — see each adapter's own
 *  maintenance.ts for field selection.
 *
 *  Unknown syntax (blank lines, `;`/`#` comments, a `key=value` line before any `[Section]`
 *  header, a line with no `=`) is skipped, not an error. A pure-whitespace or otherwise
 *  unparsable file returns an empty map rather than throwing — one real sampled PMDG
 *  `.hours` file was exactly this (whitespace padding, no sections at all), so callers must
 *  degrade to "no data" for it, not crash. */
export function parseIniSections(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>()
  let current: Record<string, string> | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue

    const sectionMatch = /^\[(.+)\]$/.exec(line)
    if (sectionMatch) {
      current = {}
      sections.set(sectionMatch[1], current)
      continue
    }

    if (!current) continue // key=value before any [Section] header — ignore, not an error

    const eq = line.indexOf('=')
    if (eq === -1) continue
    current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }

  return sections
}
