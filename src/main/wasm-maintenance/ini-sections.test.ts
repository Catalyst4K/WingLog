import { describe, expect, it } from 'vitest'
import { parseIniSections } from './ini-sections'

describe('parseIniSections', () => {
  it('parses multiple sections and key=value pairs', () => {
    const text = ['[Engines]', 'OilQ_Last.0=1854', 'OilQ_Last.1=1740', '', '[Wheels]', 'Wheel Assy State.0=2'].join(
      '\n'
    )
    expect(parseIniSections(text)).toEqual(
      new Map([
        ['Engines', { 'OilQ_Last.0': '1854', 'OilQ_Last.1': '1740' }],
        ['Wheels', { 'Wheel Assy State.0': '2' }]
      ])
    )
  })

  it('returns an empty map for pure-whitespace input', () => {
    expect(parseIniSections('   \n\t\n   ').size).toBe(0)
  })

  it('returns an empty map for empty input', () => {
    expect(parseIniSections('').size).toBe(0)
  })

  it('ignores a key=value line before any [Section] header', () => {
    const result = parseIniSections('orphan=value\n[Engines]\nOilQ_Last.0=1854')
    expect(result.get('Engines')).toEqual({ 'OilQ_Last.0': '1854' })
    expect([...result.keys()]).toEqual(['Engines'])
  })

  it('ignores a line with no =', () => {
    const result = parseIniSections('[Engines]\nnot a key value line\nOilQ_Last.0=1854')
    expect(result.get('Engines')).toEqual({ 'OilQ_Last.0': '1854' })
  })

  it('ignores comment lines starting with ; or #', () => {
    const result = parseIniSections('[Engines]\n; a comment\n# another comment\nOilQ_Last.0=1854')
    expect(result.get('Engines')).toEqual({ 'OilQ_Last.0': '1854' })
  })

  it('handles CRLF line endings', () => {
    const result = parseIniSections('[Engines]\r\nOilQ_Last.0=1854\r\n')
    expect(result.get('Engines')).toEqual({ 'OilQ_Last.0': '1854' })
  })

  it('trims whitespace around keys and values', () => {
    const result = parseIniSections('[Engines]\n  OilQ_Last.0  =  1854  ')
    expect(result.get('Engines')).toEqual({ 'OilQ_Last.0': '1854' })
  })
})
