import { describe, expect, it } from 'vitest'
import { findAirlineByIcao, loadAirlines, searchAirlineList, searchAirlines } from './airline-search'

// Shaped like the real trimmed resources/airlines.csv, including a name containing a
// comma (quoted) and a row with no IATA code (some carriers genuinely have none).
const FIXTURE_CSV = `name,icao,iata
Lufthansa,DLH,LH
"Kelowna Flightcraft Air Charter, Ltd.",KFA,
British Airways,BAW,BA
Ryanair,RYR,FR`

describe('loadAirlines', () => {
  it('parses name/icao/iata from real-shaped rows, including a quoted comma and a missing IATA', () => {
    const airlines = loadAirlines(FIXTURE_CSV)
    expect(airlines).toEqual([
      { name: 'Lufthansa', icao: 'DLH', iata: 'LH' },
      { name: 'Kelowna Flightcraft Air Charter, Ltd.', icao: 'KFA', iata: '' },
      { name: 'British Airways', icao: 'BAW', iata: 'BA' },
      { name: 'Ryanair', icao: 'RYR', iata: 'FR' }
    ])
  })
})

describe('searchAirlineList', () => {
  const airlines = loadAirlines(FIXTURE_CSV)

  it('matches by ICAO code or name, case-insensitively', () => {
    expect(searchAirlineList(airlines, 'dlh')).toEqual([airlines[0]])
    expect(searchAirlineList(airlines, 'lufthansa')).toEqual([airlines[0]])
    expect(searchAirlineList(airlines, 'ryanair')).toEqual([airlines[3]])
  })

  it('matches a name containing a comma that survived quoted parsing', () => {
    expect(searchAirlineList(airlines, 'kelowna')).toEqual([airlines[1]])
  })

  it('returns nothing for a query under 2 characters, to avoid matching everything', () => {
    expect(searchAirlineList(airlines, 'l')).toEqual([])
    expect(searchAirlineList(airlines, '')).toEqual([])
  })

  it('returns nothing for a query that matches no row', () => {
    expect(searchAirlineList(airlines, 'atlantis')).toEqual([])
  })
})

describe('searchAirlines (real vendored data)', () => {
  it('finds a well-known airline by ICAO code', () => {
    const results = searchAirlines('DLH')
    expect(results.some((r) => r.name === 'Lufthansa' && r.iata === 'LH')).toBe(true)
  })

  it('finds a well-known airline by name', () => {
    const results = searchAirlines('British Airways')
    expect(results.some((r) => r.icao === 'BAW' && r.iata === 'BA')).toBe(true)
  })

  it('finds a rebrand/historical alias not in the OpenFlights data under that name', () => {
    const results = searchAirlines('Cathay Dragon')
    expect(results.some((r) => r.icao === 'HDA' && r.iata === 'KA')).toBe(true)
  })

  it('demonstrates the bug findAirlineByIcao exists to fix: "SIA" has enough substring matches that the exact row falls past the result cap', () => {
    const results = searchAirlines('SIA')
    expect(results.some((r) => r.icao === 'SIA')).toBe(false)
  })
})

describe('findAirlineByIcao (real vendored data)', () => {
  it('finds Singapore Airlines by its exact ICAO code, the case searchAirlines misses', () => {
    expect(findAirlineByIcao('SIA')).toEqual({ name: 'Singapore Airlines', icao: 'SIA', iata: 'SQ' })
  })

  it('is case-insensitive', () => {
    expect(findAirlineByIcao('sia')?.name).toBe('Singapore Airlines')
  })

  it('returns undefined for an unknown code', () => {
    // A 4-letter string, deliberately not a real 3-letter ICAO code (unlike "ZZZ", which
    // turned out to be Zabaykalskii Airlines' real code).
    expect(findAirlineByIcao('QQQQ')).toBeUndefined()
  })

  it('returns undefined for an empty string', () => {
    expect(findAirlineByIcao('')).toBeUndefined()
  })
})
