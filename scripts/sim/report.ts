/**
 * The page every simulation writes: a short "what to look for" list, a key, then one section per
 * scenario with its numbers and maps (winglog-backend docs/plans/robustness/scenario-testing.md
 * Part 6). One format for every feature, so there's one way to look at any of it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeHtml } from './svg'

export interface ReportSection {
  title: string
  /** One line under the title (the clearance, where the data came from). Plain text. */
  meta: string
  /** Numbers for this scenario, as label and value. Plain text. */
  metrics: { label: string; value: string; was?: string }[]
  /** Why this scenario can't be scored fairly, shown instead of the metrics. Plain text. */
  notScored?: string
  /** Maps and figures: trusted HTML built with svg.ts, which escapes external text. */
  figures: string
}

export interface Report {
  /** The page title, a short name. */
  title: string
  /** What was simulated, from what data. Plain text. */
  intro: string
  /** What Callum should check by eye. Plain text. */
  lookFor: string[]
  /** The map key: colour and meaning. */
  key: { colour: string; label: string }[]
  /** Overall numbers across scenarios. */
  summary: { label: string; value: string }[]
  sections: ReportSection[]
}

const STYLE = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--map:#ecebe8;--net:#bdb8b2;--card:#ffffff;--accent:#b45309}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1c1b1a;--fg:#f5f5f4;--muted:#a8a29e;--map:#272524;--net:#57534e;--card:#232120;--accent:#f59e0b}}
:root[data-theme="dark"]{--bg:#1c1b1a;--fg:#f5f5f4;--muted:#a8a29e;--map:#272524;--net:#57534e;--card:#232120;--accent:#f59e0b}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0 auto;padding:24px 16px 64px;max-width:820px}
h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:0 0 4px}h3{font-size:14px;margin:18px 0 8px;font-weight:600}
section{background:var(--card);border-radius:12px;padding:18px;margin:22px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.meta,.was{color:var(--muted)}.meta{margin:0 0 6px}.note{color:var(--muted);font-style:italic}
.look{border-left:3px solid var(--accent);padding:4px 0 4px 14px;margin:16px 0}.look ul{margin:6px 0 0;padding-left:18px}
.stats{list-style:none;padding:0;margin:0 0 12px;display:flex;flex-wrap:wrap;gap:6px 18px}
.key{display:flex;flex-wrap:wrap;gap:6px 16px;color:var(--muted);font-size:14px}.sw{display:inline-block;width:22px;height:4px;vertical-align:middle;margin-right:6px;border-radius:2px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}figure{margin:0}figcaption{color:var(--muted);font-size:13px;text-align:center;margin-top:4px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
@media (max-width:520px){.pair{grid-template-columns:1fr}}
`

function sectionHtml(section: ReportSection): string {
  const stats = section.notScored
    ? `<p class="note">${escapeHtml(section.notScored)}</p>`
    : `<ul class="stats">${section.metrics
        .map(
          (m) =>
            `<li>${escapeHtml(m.label)}: <b>${escapeHtml(m.value)}</b>${m.was ? ` <span class="was">(today ${escapeHtml(m.was)})</span>` : ''}</li>`
        )
        .join('')}</ul>`
  return `<section><h2>${escapeHtml(section.title)}</h2><p class="meta">${escapeHtml(section.meta)}</p>${stats}${section.figures}</section>`
}

/** The report as one self-contained HTML page. */
export function renderReport(report: Report): string {
  const key = report.key
    .map(
      (k) =>
        `<span><i class="sw" style="background:${escapeHtml(k.colour)}"></i>${escapeHtml(k.label)}</span>`
    )
    .join('')
  const summary = report.summary
    .map((s) => `<li>${escapeHtml(s.label)}: <b>${escapeHtml(s.value)}</b></li>`)
    .join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.title)}</title><style>${STYLE}</style></head><body>
<h1>${escapeHtml(report.title)}</h1>
<p class="meta">${escapeHtml(report.intro)}</p>
<div class="look"><b>What to look for</b><ul>${report.lookFor.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
<ul class="stats">${summary}</ul>
<p class="key">${key}</p>
${report.sections.map(sectionHtml).join('\n')}
</body></html>`
}

/** WingLog's `release/sim/<feature>/`: gitignored, since reports show real flights. */
export function simOutputDir(feature: string): string {
  const dir = join(process.cwd(), 'release', 'sim', feature)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Writes the report page and the raw results beside it; returns the page's path. */
export function writeReport(feature: string, report: Report, results: unknown): string {
  const dir = simOutputDir(feature)
  writeFileSync(join(dir, 'results.json'), JSON.stringify(results, null, 2))
  const page = join(dir, 'index.html')
  writeFileSync(page, renderReport(report))
  return page
}
