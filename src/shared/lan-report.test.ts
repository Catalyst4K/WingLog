import { describe, expect, it } from 'vitest'
import { MAX_REPORT_DETAIL, parseReport, parseReportDetail, queryFailedReport } from './lan-report'

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

describe('parseReport: what the page says about hearing the PC and about itself', () => {
  it('knows a reconnection, a route and a taxi line applied, and a script error', () => {
    for (const code of ['reconnected', 'route-applied', 'taxi-route-applied', 'script-error'])
      expect(parseReport(code)).toBe(code)
  })
})

describe('parseReportDetail', () => {
  const NEWLINE = String.fromCharCode(10)

  it('takes a revision, and only a revision, for the route and taxi line reports', () => {
    for (const code of ['route-applied', 'taxi-route-applied']) {
      expect(parseReportDetail(code, 'r12')).toBe('r12')
      expect(parseReportDetail(code, 'r')).toBeNull()
      expect(parseReportDetail(code, 'r12 [lan] fake line')).toBeNull()
      expect(parseReportDetail(code, '12')).toBeNull()
      expect(parseReportDetail(code, 'r1234567890')).toBeNull()
    }
  })

  it('makes a script error one line: control characters, with the newlines that could fake a log line, become spaces', () => {
    const detail =
      ['Uncaught', 'Error:', 'boom'].join(NEWLINE) +
      String.fromCharCode(0) +
      '[lan] fake' +
      String.fromCharCode(13)
    expect(parseReportDetail('script-error', detail)).toBe('Uncaught Error: boom [lan] fake')
    expect(parseReportDetail('script-error', 'a' + String.fromCharCode(0x2028) + 'b')).toBe('a b')
  })

  it('cuts a script error at the limit, however long it is', () => {
    expect(parseReportDetail('script-error', 'x'.repeat(5000))).toHaveLength(MAX_REPORT_DETAIL)
    expect(parseReportDetail('script-error', 'ab')).toBe('ab')
  })

  it('gives nothing for a detail that is empty, not text, or sent with a code that takes none', () => {
    expect(parseReportDetail('script-error', '')).toBeNull()
    expect(parseReportDetail('script-error', NEWLINE + ' ' + NEWLINE)).toBeNull()
    expect(parseReportDetail('script-error', 42)).toBeNull()
    expect(parseReportDetail('script-error', { message: 'x' })).toBeNull()
    expect(parseReportDetail('selection-unconfirmed', 'anything')).toBeNull()
    expect(parseReportDetail('reconnected', 'r1')).toBeNull()
    expect(parseReportDetail('query-failed:taxi.get', 'x')).toBeNull()
    expect(parseReportDetail('__proto__', 'x')).toBeNull()
  })
})
