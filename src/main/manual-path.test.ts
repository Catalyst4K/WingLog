import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { manualPath } from './manual-path'

describe('manualPath', () => {
  it("is in the installed app's resources folder, where electron-builder puts it", () => {
    expect(manualPath(true, 'C:/Program Files/WingLog/resources', 'ignored')).toBe(
      join('C:/Program Files/WingLog/resources', 'WingLog Manual.pdf')
    )
  })

  it('is the manual:build output when running from source', () => {
    expect(manualPath(false, 'ignored', 'C:/src/winglog')).toBe(join('C:/src/winglog', 'release', 'manual', 'WingLog Manual.pdf'))
  })
})
