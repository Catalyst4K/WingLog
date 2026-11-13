import { describe, expect, it } from 'vitest'
import {
  findAirlineByIcao,
  findAirlineForOperator,
  loadAirlines,
  matchOperatorAirline,
  searchAirlineList,
  searchAirlines
} from './airline-search'

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

describe('matchOperatorAirline: the ICAO of an aircraft saved without one', () => {
  const airlines = loadAirlines(`name,icao,iata
British Airways,BAW,BA
British Airways,XMS,
Singapore Airlines,SIA,SQ
Singapore Airlines Cargo,SQC,SQ
Cathay Dragon,HDA,KA
Dragonair,HDA,KA
Korean Air,KAL,KE
Alitalia,AZA,AZ
Flitestar,===,GM`)

  it('takes the airline whose name and IATA code both agree, whatever the case', () => {
    expect(matchOperatorAirline(airlines, 'Singapore Airlines', 'SQ')?.icao).toBe('SIA')
    expect(matchOperatorAirline(airlines, ' british AIRWAYS ', 'ba')?.icao).toBe('BAW')
  })

  it('takes the only airline with the IATA code when no name was saved', () => {
    expect(matchOperatorAirline(airlines, null, 'KE')?.icao).toBe('KAL')
    expect(matchOperatorAirline(airlines, '  ', 'KE')?.icao).toBe('KAL')
  })

  it('finds nothing when the saved name disagrees with the only airline that has the code', () => {
    expect(matchOperatorAirline(airlines, 'ITA Airways', 'AZ')).toBeUndefined()
    expect(matchOperatorAirline(airlines, 'Korean Air Lines', 'KE')).toBeUndefined()
  })

  it('takes two list entries for the same airline (a rebrand under one ICAO) as one answer', () => {
    expect(matchOperatorAirline(airlines, 'Cathay Dragon', 'KA')?.icao).toBe('HDA')
    expect(matchOperatorAirline(airlines, null, 'KA')?.icao).toBe('HDA')
  })

  it('does not guess between airlines that share an IATA code and a name does not settle', () => {
    expect(matchOperatorAirline(airlines, null, 'SQ')).toBeUndefined()
    expect(matchOperatorAirline(airlines, 'Singapore', 'SQ')).toBeUndefined()
  })

  it('never turns a name alone into a code, even one only a single airline has', () => {
    expect(matchOperatorAirline(airlines, 'Korean Air', null)).toBeUndefined()
    expect(matchOperatorAirline(airlines, 'Korean Air', '')).toBeUndefined()
    expect(matchOperatorAirline(airlines, 'Alitalia', ' ')).toBeUndefined()
  })

  it('does not take a placeholder ICAO from the list', () => {
    expect(matchOperatorAirline(airlines, null, 'GM')).toBeUndefined()
    expect(matchOperatorAirline(airlines, 'Flitestar', 'GM')).toBeUndefined()
  })

  it('finds nothing when it has neither a name nor a code', () => {
    expect(matchOperatorAirline(airlines, null, null)).toBeUndefined()
    expect(matchOperatorAirline(airlines, '', '  ')).toBeUndefined()
  })

  it('finds nothing in the vendored list for a name that disagrees with its code', () => {
    const disagreeing: [string, string][] = [
      ['ITA Airways', 'AZ'],
      ['Breeze Airways', 'MX'],
      ['Discover Airlines', '4Y'],
      ['Lufthansa City Airlines', 'VL'],
      ['Lufthansa CityLine', 'VL']
    ]
    for (const [name, iata] of disagreeing) {
      expect(findAirlineForOperator(name, iata), name).toBeUndefined()
    }
  })

  it('finds nothing in the vendored list for a typed name with no code', () => {
    for (const name of ['Global Airways', 'Jet Airways', 'Court Line', 'Samurai Airlines', 'Korean Air']) {
      expect(findAirlineForOperator(name, null), name).toBeUndefined()
    }
  })

  it('gives the right ICAO for the airlines this fleet actually flies, from the vendored list', () => {
    const real: [string, string, string][] = [
      ['British Airways', 'BA', 'BAW'],
      ['Korean Air', 'KE', 'KAL'],
      ['Cathay Pacific', 'CX', 'CPA'],
      ['Cathay Dragon', 'KA', 'HDA'],
      ['Hong Kong Express Airways', 'UO', 'HKE'],
      ['Singapore Airlines', 'SQ', 'SIA']
    ]
    for (const [name, iata, icao] of real) {
      expect(findAirlineForOperator(name, iata)?.icao, name).toBe(icao)
    }
  })
})
