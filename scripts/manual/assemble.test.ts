import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleManual, checkReferences, readChapters, slug } from './assemble'

const dirs: string[] = []
function manualDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'winglog-manual-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'images'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the manual build (user-docs-v1-4.md)', () => {
  it('reads only NN-name.md chapters, in order', () => {
    const dir = manualDir({
      '02-fleet.md': '# Fleet',
      '01-introduction.md': '# Introduction',
      'notes.md': 'x',
      'manual.css': ''
    })
    expect(readChapters(dir).map((c) => c.file)).toEqual(['01-introduction.md', '02-fleet.md'])
  })

  it('fails on a missing image, an image outside images/, and a link to a chapter that does not exist', () => {
    const dir = manualDir({
      '01-a.md':
        '# A\n\n![Track](images/track.png)\n\n![x](../secret.png)\n\nSee [Fleet](02-fleet.md) and [Track](05-track.md#the-map).'
    })
    writeFileSync(join(dir, 'images', 'unused.png'), '')
    const problems = checkReferences(readChapters(dir), dir)
    expect(problems).toEqual([
      '01-a.md: missing image images/track.png',
      '01-a.md: image outside images/: ../secret.png',
      '01-a.md: link to unknown chapter 02-fleet.md',
      '01-a.md: link to unknown chapter 05-track.md#the-map'
    ])
  })

  it('accepts real images, https links and links to real chapters', () => {
    const dir = manualDir({
      '01-a.md':
        '# A\n\n![Map](images/map.png)\n\n[B](02-b.md) [site](https://github.com/Catalyst4K/WingLog)',
      '02-b.md': '# B'
    })
    writeFileSync(join(dir, 'images', 'map.png'), '')
    expect(checkReferences(readChapters(dir), dir)).toEqual([])
  })

  it('builds a cover with the version and the simulation-only notice, a contents list, and in-document chapter links', () => {
    const dir = manualDir({
      '01-introduction.md':
        '# Introduction\n\n## What WingLog does\n\nSee [Track](02-track.md) and [its map](02-track.md#the-map).',
      '02-track.md': '# Track\n\n## The map\n\n### Deep heading'
    })
    const { html, problems } = assembleManual(readChapters(dir), dir, { version: '1.4.0', css: 'body{}' })
    expect(problems).toEqual([])
    expect(html).toContain('version 1.4.0')
    expect(html).toContain('For flight simulation use only.')
    expect(html).toContain('<li class="toc-1"><a href="#introduction">Introduction</a></li>')
    expect(html).toContain('<li class="toc-2"><a href="#the-map">The map</a></li>')
    expect(html).not.toContain('toc-3')
    expect(html).toContain('<a href="#track">Track</a>')
    expect(html).toContain('<a href="#the-map">its map</a>')
    expect(html).toContain('<h3 id="deep-heading">Deep heading</h3>')
  })

  it('slugs headings for anchors', () => {
    expect(slug('If WingLog closes mid-flight')).toBe('if-winglog-closes-mid-flight')
    expect(slug('GSX <em>Remote</em> Control')).toBe('gsx-remote-control')
  })

  it('the real manual in docs/manual builds with no problems', () => {
    const dir = join(__dirname, '..', '..', 'docs', 'manual')
    expect(checkReferences(readChapters(dir), dir)).toEqual([])
    expect(readChapters(dir).length).toBeGreaterThanOrEqual(12)
  })
})
