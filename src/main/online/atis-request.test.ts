import { describe, expect, it } from 'vitest'
import { MAX_ATIS_REQUESTS, parseAtisRequests } from './atis-request'

describe('parseAtisRequests', () => {
  it('reads each airport and tab, in order, with the code in upper case', () => {
    expect(
      parseAtisRequests([
        { icao: 'egll', slot: 'departure' },
        { icao: 'LFPG', slot: 'custom' }
      ])
    ).toEqual([
      { icao: 'EGLL', slot: 'departure' },
      { icao: 'LFPG', slot: 'custom' }
    ])
  })

  it('accepts none, and exactly the most allowed', () => {
    expect(parseAtisRequests([])).toEqual([])
    const full = Array.from({ length: MAX_ATIS_REQUESTS }, () => ({ icao: 'EGLL', slot: 'alternate' }))
    expect(parseAtisRequests(full)).toHaveLength(MAX_ATIS_REQUESTS)
  })

  it.each([
    ['not a list', 'EGLL'],
    ['null', null],
    ['an object', { icao: 'EGLL', slot: 'departure' }],
    [
      'one too many',
      Array.from({ length: MAX_ATIS_REQUESTS + 1 }, () => ({ icao: 'EGLL', slot: 'departure' }))
    ],
    ['an entry that is not an object', ['EGLL']],
    ['a null entry', [null]],
    ['a code of three characters', [{ icao: 'EGL', slot: 'departure' }]],
    ['a code of five characters', [{ icao: 'EGLLX', slot: 'departure' }]],
    ['a code with punctuation', [{ icao: 'EG_L', slot: 'departure' }]],
    ['a code that is not text', [{ icao: 1234, slot: 'departure' }]],
    ['a tab that does not exist', [{ icao: 'EGLL', slot: 'arrival' }]],
    ['no tab', [{ icao: 'EGLL' }]]
  ])('refuses %s', (_name, value) => {
    expect(() => parseAtisRequests(value)).toThrow('Invalid ATIS request')
  })
})
