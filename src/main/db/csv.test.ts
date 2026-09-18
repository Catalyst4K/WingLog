import { describe, expect, it } from 'vitest'
import { columnIndex, parseCsvRows, toCsv } from './csv'

describe('parseCsvRows', () => {
  it('splits plain rows on LF and CRLF, trims cells, and drops blank lines', () => {
    expect(parseCsvRows('a, b ,c\r\n\r\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ])
  })

  it('reads the last row even with no trailing newline', () => {
    expect(parseCsvRows('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('handles quoted commas, doubled quotes and embedded newlines', () => {
    const text = 'name,note\r\n"Total RF Heliport","say ""hi"", then\r\nleave"\r\n'
    expect(parseCsvRows(text)).toEqual([
      ['name', 'note'],
      ['Total RF Heliport', 'say "hi", then\r\nleave']
    ])
  })

  it('keeps empty cells and returns nothing for empty input', () => {
    expect(parseCsvRows('a,,c\n')).toEqual([['a', '', 'c']])
    expect(parseCsvRows('')).toEqual([])
  })
})

describe('toCsv', () => {
  it('writes CRLF-terminated rows, leaving plain fields unquoted and nulls empty', () => {
    expect(toCsv([['a', 'b'], ['x', null], [1, 2.5]])).toBe('a,b\r\nx,\r\n1,2.5\r\n')
  })

  it('quotes commas, quotes and newlines, and doubles embedded quotes', () => {
    expect(toCsv([['a,b', 'say "hi"', 'line1\nline2']])).toBe('"a,b","say ""hi""","line1\nline2"\r\n')
  })

  it('round-trips awkward fields, including non-ASCII, through parseCsvRows', () => {
    const rows = [
      ['registration', 'note'],
      ['G-ÄBCD', 'comma, "quote"\r\nnewline'],
      ['N123', '']
    ]
    expect(parseCsvRows(toCsv(rows))).toEqual(rows)
  })
})

describe('columnIndex', () => {
  it('finds a header case-insensitively, or -1', () => {
    expect(columnIndex(['Reg', 'Type'], 'type')).toBe(1)
    expect(columnIndex(['Reg'], 'nope')).toBe(-1)
  })
})
