import { describe, expect, it } from 'vitest'
import { atisRunwaysFromBeyondAtc, parseDatisLine } from './beyondatc-datis'

// The texts are BeyondATC's own, read live on 2026-10-29 and from its Player.log.
const EGLL =
  'EGLL ATIS R 2338Z 06003KT 9999 NCD 10/10 Q1029 ARR RWY 27 RIGHT DEP RWY 27 LEFT TRANSITION-LEVEL FL060 READBACK ALL HOLD SHORT INSTRUCTIONS ACKNOWLEDGE RECEIPT OF INFORMATION R AND ADVISE AIRCRAFT TYPE ON FIRST CONTACT'
const WSSS =
  'WSSS ATIS E 2338Z WIND CALM 9999 FEW018 BKN300 25/23 Q1013 ARR RWY 20 RIGHT DEP RWY 20 CENTER TRANSITION-LEVEL FL130 ACKNOWLEDGE RECEIPT OF INFORMATION E AND ADVISE AIRCRAFT TYPE ON FIRST CONTACT'
const KJFK_SEVERAL =
  'KJFK ATIS F 0109Z 29002KT 12/01 3054 ARR RWY 22 LEFT 31 LEFT 31 RIGHT DEP RWY 31 LEFT ACKNOWLEDGE RECEIPT OF INFORMATION F'
const WSSS_BOTH =
  'WSSS ATIS T 0309Z 21006KT 4000 HZ Q1012 RWY 20 CENTER IN USE TRANSITION-LEVEL FL130 ACKNOWLEDGE RECEIPT'

describe('atisRunwaysFromBeyondAtc', () => {
  it('reads one arrival and one departure runway, a side word becoming its letter', () => {
    expect(atisRunwaysFromBeyondAtc(EGLL)).toEqual({ arrival: ['27R'], departure: ['27L'] })
    expect(atisRunwaysFromBeyondAtc(WSSS)).toEqual({ arrival: ['20R'], departure: ['20C'] })
  })

  it('reads every arrival runway BeyondATC lists, and stops at DEP', () => {
    expect(atisRunwaysFromBeyondAtc(KJFK_SEVERAL)).toEqual({
      arrival: ['22L', '31L', '31R'],
      departure: ['31L']
    })
    expect(
      atisRunwaysFromBeyondAtc('ARR RWY 20 CENTER 20 RIGHT DEP RWY 20 CENTER TRANSITION-LEVEL FL130')
    ).toEqual({ arrival: ['20C', '20R'], departure: ['20C'] })
  })

  it('takes "RWY … IN USE" as the runway for both', () => {
    expect(atisRunwaysFromBeyondAtc(WSSS_BOTH)).toEqual({ arrival: ['20C'], departure: ['20C'] })
  })

  it('reads letters already written as L, R or C, a number alone, and AND between runways', () => {
    expect(atisRunwaysFromBeyondAtc('ARR RWY 09L AND 09R DEP RWY 27 ACK')).toEqual({
      arrival: ['09L', '09R'],
      departure: ['27']
    })
  })

  it('gives nothing for text with no runway, a runway number off the dial, or a bare RWY', () => {
    expect(atisRunwaysFromBeyondAtc('EGLL ATIS R 2338Z 06003KT 9999 NCD 10/10 Q1029')).toEqual({
      arrival: [],
      departure: []
    })
    expect(atisRunwaysFromBeyondAtc('ARR RWY 45 DEP RWY 27')).toEqual({ arrival: [], departure: ['27'] })
    expect(atisRunwaysFromBeyondAtc('RWY 27 CLOSED')).toEqual({ arrival: [], departure: [] })
    expect(atisRunwaysFromBeyondAtc('')).toEqual({ arrival: [], departure: [] })
  })
})

describe('parseDatisLine', () => {
  it('reads a real line: the airport, the letter, the text and its runways', () => {
    expect(parseDatisLine(`EGLL|R|${EGLL}`)).toEqual({
      icao: 'EGLL',
      code: 'R',
      text: EGLL,
      arrivalRunways: ['27R'],
      departureRunways: ['27L']
    })
  })

  it('keeps a "|" inside the text and tidies spaces and control characters', () => {
    const parsed = parseDatisLine('wsss|e|WSSS  ATIS\tE | ARR RWY 20\u0007 RIGHT')
    expect(parsed?.icao).toBe('WSSS')
    expect(parsed?.code).toBe('E')
    expect(parsed?.text).toBe('WSSS ATIS E | ARR RWY 20 RIGHT')
    expect(parsed?.arrivalRunways).toEqual(['20R'])
  })

  it('has no letter when the field is not one letter', () => {
    expect(parseDatisLine('EGLL||EGLL ATIS')?.code).toBeNull()
    expect(parseDatisLine('EGLL|RR|EGLL ATIS')?.code).toBeNull()
  })

  it('cuts a very long text', () => {
    expect(parseDatisLine(`EGLL|R|${'A '.repeat(3_000)}`)?.text.length).toBeLessThanOrEqual(2_000)
  })

  it.each([
    ['no separators', 'EGLL ATIS R'],
    ['one separator', 'EGLL|R'],
    ['a five-letter airport', 'EGLLX|R|text'],
    ['a three-letter airport', 'EGL|R|text'],
    ['an empty text', 'EGLL|R|   '],
    ['an empty line', '']
  ])('drops a line with %s', (_name, line) => {
    expect(parseDatisLine(line)).toBeNull()
  })
})
