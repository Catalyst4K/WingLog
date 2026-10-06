import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The dev build (diagnostic logging, flight capture) must never be what ships. The flag is
 * only set by `package:win:dev`, which names its installer "WingLog-Dev-…", so the two can't
 * be mixed up (flightdeck-backend robustness/dev-build.md).
 */
const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts

describe('dev build release safety', () => {
  it('no CI workflow sets the dev-build flag', () => {
    const dir = join('.github', 'workflows')
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toContain('WINGLOG_DEV_BUILD')
    }
  })

  it('only package:win:dev sets it, and its installer is named as the dev build', () => {
    const setting = Object.entries(scripts).filter(([, command]) => command.includes('WINGLOG_DEV_BUILD'))
    expect(setting.map(([name]) => name)).toEqual(['package:win:dev'])
    expect(scripts['package:win:dev']).toContain('-c.win.artifactName=${productName}-Dev-${version}')
    expect(scripts['package:win']).not.toContain('WINGLOG_DEV_BUILD')
  })
})
