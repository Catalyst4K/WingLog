import { describe, expect, it } from 'vitest'
import { parseReport, queryFailedReport } from './lan-report'

describe('parseReport', () => {
  it('knows the reports that carry no name', () => {
    expect(parseReport('selection-unconfirmed')).toBe('selection-unconfirmed')
    expect(parseReport('route-missing')).toBe('route-missing')
  })

  it('knows a failed lookup only by a name in the lookup table', () => {
    expect(parseReport(queryFailedReport('navdata.listSids'))).toBe('query-failed:navdata.listSids')
    expect(parseReport('query-failed:made.up')).toBeNull()
    expect(parseReport('query-failed:__proto__')).toBeNull()
    expect(parseReport('query-failed:')).toBeNull()
  })

  it('refuses anything else, including text a device made up and things that are not text', () => {
    expect(parseReport('hello')).toBeNull()
    expect(parseReport('route-missing\n[lan] fake')).toBeNull()
    expect(parseReport('x'.repeat(200))).toBeNull()
    expect(parseReport(7)).toBeNull()
    expect(parseReport(null)).toBeNull()
    expect(parseReport({ code: 'route-missing' })).toBeNull()
  })
})
