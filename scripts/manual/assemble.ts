import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { marked } from 'marked'

/**
 * Turns the manual's Markdown chapters (docs/manual/NN-*.md) into one HTML page for
 * printing to PDF (winglog-backend's docs/plans/user-docs-v1-4.md). Pure apart from
 * reading the chapter and image files, so it's unit-tested; scripts/manual/build.ts does the
 * Electron printing.
 */

export interface ManualChapter {
  file: string
  markdown: string
}

export interface AssembledManual {
  html: string
  /** Problems that must fail the build: a missing image, a link to a missing chapter. */
  problems: string[]
}

/** The chapters in order: files named "NN-name.md". */
export function readChapters(dir: string): ManualChapter[] {
  return readdirSync(dir)
    .filter((f) => /^\d{2}-.+\.md$/.test(f))
    .sort()
    .map((file) => ({ file, markdown: readFileSync(join(dir, file), 'utf8') }))
}

/** Every image and every link to another chapter must exist. External links (https:) are
 *  left alone; anything else (file:, javascript:, a bare path outside the manual) is a
 *  problem, since the PDF is shipped to users. */
export function checkReferences(chapters: ManualChapter[], dir: string): string[] {
  const problems: string[] = []
  const chapterFiles = new Set(chapters.map((c) => c.file))
  for (const chapter of chapters) {
    for (const m of chapter.markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      const src = m[1]!
      if (!src.startsWith('images/') || src.includes('..'))
        problems.push(`${chapter.file}: image outside images/: ${src}`)
      else if (!existsSync(resolve(dir, src))) problems.push(`${chapter.file}: missing image ${src}`)
    }
    for (const m of chapter.markdown.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      const href = m[1]!
      if (href.startsWith('https://') || href.startsWith('#')) continue
      const target = href.split('#')[0]!
      if (!chapterFiles.has(target)) problems.push(`${chapter.file}: link to unknown chapter ${href}`)
    }
  }
  return problems
}

/** A heading's id: the same slug for the table of contents and the anchor. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function assembleManual(
  chapters: ManualChapter[],
  dir: string,
  options: { version: string; css: string }
): AssembledManual {
  const problems = checkReferences(chapters, dir)
  const toc: { level: number; text: string; id: string }[] = []
  const renderer = new marked.Renderer()
  renderer.heading = ({ tokens, depth }) => {
    const text = marked.Parser.parseInline(tokens)
    const id = slug(text)
    if (depth <= 2) toc.push({ level: depth, text, id })
    return `<h${depth} id="${id}">${text}</h${depth}>\n`
  }
  // Links between chapters become in-document anchors: "05-track.md#the-map" → "#the-map",
  // and a bare "05-track.md" → that chapter's first heading.
  const firstHeading = new Map(
    chapters.map((c) => [c.file, slug(/^#\s+(.+)$/m.exec(c.markdown)?.[1] ?? c.file)] as const)
  )
  renderer.link = ({ href, tokens }) => {
    const text = marked.Parser.parseInline(tokens)
    if (href.startsWith('https://')) return `<a href="${href}">${text}</a>`
    const [file, anchor] = href.split('#')
    const target = anchor || (file ? firstHeading.get(file) : '') || ''
    return `<a href="#${target}">${text}</a>`
  }

  const body = chapters
    .map(
      (c) =>
        `<section class="chapter">${marked.parse(c.markdown, { renderer, async: false }) as string}</section>`
    )
    .join('\n')
  const tocHtml = toc
    .map((e) => `<li class="toc-${e.level}"><a href="#${e.id}">${e.text}</a></li>`)
    .join('\n')

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>WingLog Manual</title>
<style>${options.css}</style>
</head>
<body>
<section class="cover">
  <h1 class="cover-title">WingLog</h1>
  <p class="cover-subtitle">User manual · version ${options.version}</p>
  <p class="cover-note">For flight simulation use only. Never for real-world navigation, flight planning, or use in a real aircraft.</p>
</section>
<nav class="toc"><h2 class="toc-title">Contents</h2><ul>${tocHtml}</ul></nav>
${body}
</body>
</html>
`
  return { html, problems }
}
