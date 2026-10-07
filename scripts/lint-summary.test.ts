import { describe, expect, it } from 'vitest'
import { areaOf, summarise } from './lint-summary'

describe('areaOf', () => {
  it('groups files the way the audit works through them', () => {
    expect(areaOf('src/main/tracking/FlightRecorder.ts')).toBe('main/tracking')
    expect(areaOf('src/main/index.ts')).toBe('main (root)')
    expect(areaOf('src/renderer/src/hooks/useX.ts')).toBe('renderer/hooks')
    expect(areaOf('src/renderer/src/LogbookView.tsx')).toBe('renderer views')
    expect(areaOf('src/renderer/src/taxi-route-trace.ts')).toBe('renderer modules')
    expect(areaOf('src/shared/stands.ts')).toBe('shared')
  })
})

describe('summarise', () => {
  it('counts per rule and per area, errors apart', () => {
    const report = summarise([
      { filePath: 'src/main/tracking/a.ts', messages: [{ ruleId: 'complexity', severity: 1 }, { ruleId: 'no-console', severity: 1 }] },
      { filePath: 'src/main/tracking/b.ts', messages: [{ ruleId: 'complexity', severity: 1 }] },
      { filePath: 'src/shared/c.ts', messages: [{ ruleId: 'no-console', severity: 2 }] },
      { filePath: 'src/shared/d.ts', messages: [] },
      { filePath: 'src/shared/e.ts', messages: [{ ruleId: null, severity: 1, message: 'Unused eslint-disable directive (no problems were reported).' }] }
    ])
    expect(report).toContain('5 findings in 4 files (1 errors).')
    expect(report).toContain('| complexity | 2 |')
    expect(report).toContain('| main/tracking | 3 | complexity 2, no-console 1 |')
    expect(report).toContain('| shared | 2 | (unused eslint-disable) 1, no-console 1 |')
  })
})
