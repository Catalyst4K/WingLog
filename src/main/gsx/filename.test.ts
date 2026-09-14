import { describe, expect, it } from 'vitest'
import { parseReceiptFilename } from './filename'

describe('parseReceiptFilename', () => {
  it('parses a real receipt filename', () => {
    expect(parseReceiptFilename('20260901T111457Z_EGLL_G-XWBS.json')).toEqual({
      timestampUtc: '2026-09-01T11:14:57Z',
      icao: 'EGLL',
      tail: 'G-XWBS'
    })
  })

  it('works the same for the paired .html file', () => {
    expect(parseReceiptFilename('20260901T111457Z_EGLL_G-XWBS.html')).toEqual({
      timestampUtc: '2026-09-01T11:14:57Z',
      icao: 'EGLL',
      tail: 'G-XWBS'
    })
  })

  it('parses a real NOTAIL filename', () => {
    expect(parseReceiptFilename('20260729T184243Z_EGNM_NOTAIL.json')).toEqual({
      timestampUtc: '2026-07-29T18:42:43Z',
      icao: 'EGNM',
      tail: 'NOTAIL'
    })
  })

  it('uppercases a lowercase ICAO', () => {
    expect(parseReceiptFilename('20260901T111457Z_egll_G-XWBS.json')?.icao).toBe('EGLL')
  })

  it('returns null for a filename that does not match the convention', () => {
    expect(parseReceiptFilename('price_list.html')).toBeNull()
    expect(parseReceiptFilename('readme.txt')).toBeNull()
    expect(parseReceiptFilename('not_a_timestamp_EGLL_G-XWBS.json')).toBeNull()
  })

  it('returns null for a timestamp that matches the pattern but is not a real date', () => {
    // Month 13 — the right shape (8 digits + T + 6 digits + Z), but not a real calendar date.
    expect(parseReceiptFilename('20261301T000000Z_EGLL_G-XWBS.json')).toBeNull()
  })
})
