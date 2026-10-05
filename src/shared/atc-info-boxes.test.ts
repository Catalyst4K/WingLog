import { describe, expect, it } from 'vitest'
import { assignedGate, parseAtcTaxiFacts } from './atc-info-boxes'

// Real InfoBoxes, verbatim from main.log (2026-10-05).
const VHHH_TAXI_OUT = [
  { title: 'Taxi to Runway', info: '07R' },
  { title: 'Taxi Via 1', info: 'B' },
  { title: 'Taxi Via 2', info: 'B' },
  { title: 'Taxi Via 3', info: 'V' },
  { title: 'Taxi Via 4', info: 'H' },
  { title: 'Taxi Via 5', info: 'J' },
  { title: 'Hold Position', info: 'J1' },
  { title: 'ATIS Current', info: 'R' }
]
const ZJSY_TAXI_IN = [
  { title: 'Taxi to Gate', info: 'Gate 102' },
  { title: 'Taxi Via 1', info: 'A4' },
  { title: 'Taxi Via 2', info: 'D' }
]
const EGLL_TAXI_IN = [
  { title: 'Taxi to Gate', info: 'Gate 411' },
  ...['A', 'R', 'N5W', 'S5W', 'W', 'LINK 44', 'T'].map((info, i) => ({ title: `Taxi Via ${i + 1}`, info })),
  { title: 'ATIS Current', info: 'C' }
]

describe('parseAtcTaxiFacts', () => {
  it('reads a departure taxi clearance: route, holding point and runway (VHHH)', () => {
    expect(parseAtcTaxiFacts(VHHH_TAXI_OUT)).toEqual({
      taxiVia: ['B', 'B', 'V', 'H', 'J'],
      holdPosition: 'J1',
      taxiToRunway: '07R',
      taxiToGate: null,
      expectGate: null
    })
  })

  it('reads an arrival taxi clearance to a gate, label removed (ZJSY)', () => {
    expect(parseAtcTaxiFacts(ZJSY_TAXI_IN)).toMatchObject({ taxiVia: ['A4', 'D'], taxiToGate: '102', holdPosition: null })
  })

  it('keeps a taxiway name with a space (EGLL LINK 44)', () => {
    expect(parseAtcTaxiFacts(EGLL_TAXI_IN).taxiVia).toEqual(['A', 'R', 'N5W', 'S5W', 'W', 'LINK 44', 'T'])
  })

  it('orders Taxi Via by number, not by arrival order, including past 9', () => {
    const boxes = Array.from({ length: 11 }, (_, i) => ({ title: `Taxi Via ${i + 1}`, info: `T${i + 1}` })).reverse()
    expect(parseAtcTaxiFacts(boxes).taxiVia).toEqual(Array.from({ length: 11 }, (_, i) => `T${i + 1}`))
  })

  it('trims titles and ignores their case, as BeyondATC sends them inconsistently', () => {
    const facts = parseAtcTaxiFacts([
      { title: ' taxi via 1 ', info: ' a4 ' },
      { title: 'HOLD POSITION', info: 'j1' },
      { title: 'taxi to  stand', info: 'Stand N32' }
    ])
    expect(facts).toMatchObject({ taxiVia: ['A4'], holdPosition: 'J1', taxiToGate: 'N32' })
  })

  it('reads the early Expect Gate box (ZJSY: 1.5 min before the taxi call)', () => {
    const facts = parseAtcTaxiFacts([
      { title: 'Expect Gate', info: 'Gate 102' },
      { title: 'Ground Frequency', info: '121.7' }
    ])
    expect(facts).toMatchObject({ expectGate: '102', taxiToGate: null, taxiVia: [] })
  })

  it('ignores unknown titles, empty values and other phases', () => {
    expect(
      parseAtcTaxiFacts([
        { title: 'STAR', info: 'UPRS2C' },
        { title: 'Arrival Runway', info: '08' },
        { title: 'Taxi Via 1', info: '  ' },
        { title: 'Taxi Via', info: 'X' },
        { title: 'Hold Position', info: '' }
      ])
    ).toEqual({ taxiVia: [], holdPosition: null, taxiToRunway: null, taxiToGate: null, expectGate: null })
    expect(parseAtcTaxiFacts([])).toMatchObject({ taxiVia: [] })
  })

  it('returns null for a gate value it cannot read', () => {
    expect(parseAtcTaxiFacts([{ title: 'Taxi to Gate', info: 'Gate 102 or 103' }]).taxiToGate).toBeNull()
  })
})

describe('assignedGate', () => {
  it('prefers the taxi clearance gate, else Expect Gate, else null', () => {
    expect(assignedGate(parseAtcTaxiFacts([...ZJSY_TAXI_IN, { title: 'Expect Gate', info: 'Gate 999' }]))).toBe('102')
    expect(assignedGate(parseAtcTaxiFacts([{ title: 'Expect Gate', info: 'Gate 102' }]))).toBe('102')
    expect(assignedGate(parseAtcTaxiFacts(VHHH_TAXI_OUT))).toBeNull()
  })
})
