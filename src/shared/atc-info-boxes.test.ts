import { describe, expect, it } from 'vitest'
import { assignedGate, boxClearedLevelFt, levelToFeet, parseAtcBoxClearance, parseAtcTaxiFacts, withoutLabel } from './atc-info-boxes'

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

// Real box sets from the VHHH-ZJSY flight, 2026-10-05 (main.log).
describe('parseAtcBoxClearance', () => {
  it('reads the departure clearance: SID and runway', () => {
    const boxes = [
      { title: 'Taxi to Runway', info: '07R' },
      { title: 'SID', info: 'PECA3A' },
      { title: 'Altitude Clearance', info: 'FL140' },
      { title: 'Squawk', info: '3711' }
    ]
    expect(parseAtcBoxClearance(boxes)).toEqual({ fields: { sidIdent: 'PECA3A', departureRunway: '07R' }, summary: 'SID PECA3A, runway 07R' })
  })

  it('reads the STAR clearance with its runway', () => {
    expect(parseAtcBoxClearance([{ title: 'STAR', info: 'UPRS2C' }, { title: 'Arrival Runway', info: '08' }])).toEqual({
      fields: { starIdent: 'UPRS2C' },
      summary: 'STAR UPRS2C, runway 08',
      arrivalRunway: '08'
    })
  })

  it('reads the approach briefing as the runway plus the approach transition', () => {
    const boxes = [
      { title: 'Approach Type', info: 'Procedure' },
      { title: 'Landing Runway', info: '08' },
      { title: 'Transition', info: 'SY498' },
      { title: 'QNH', info: 'QNH 1014' }
    ]
    expect(parseAtcBoxClearance(boxes)).toEqual({ fields: { approachTransition: 'SY498' }, summary: 'Runway 08 via SY498', arrivalRunway: '08' })
  })

  it('reads the approach clearance, named the way the sim names it', () => {
    const boxes = [
      { title: 'Cross SY498', info: 'At or above 1,200m' },
      { title: 'Cleared Approach', info: 'ILS-Z approach runway 08' }
    ]
    expect(parseAtcBoxClearance(boxes)).toEqual({ fields: { approachIdent: 'ILS Z 08' }, summary: 'Approach ILS Z 08' })
  })

  it('reads a lone Landing Runway as the runway only', () => {
    expect(parseAtcBoxClearance([{ title: 'Landing Runway', info: '08' }, { title: 'QNH', info: 'QNH 1014' }])).toEqual({
      fields: {},
      summary: 'Runway 08',
      arrivalRunway: '08'
    })
  })

  it('is null for sets with no procedure: taxi, frequency, speed, takeoff', () => {
    for (const boxes of [
      [{ title: 'Taxi to Runway', info: '07R' }, { title: 'Taxi Via 1', info: 'B' }],
      [{ title: ' Frequency', info: '123.8' }],
      [{ title: 'Reduce Speed', info: '220' }],
      [{ title: 'Cleared for Takeoff', info: '07R' }],
      []
    ]) {
      expect(parseAtcBoxClearance(boxes)).toBeNull()
    }
  })
})

describe('boxClearedLevelFt', () => {
  it('reads every level title seen, in flight levels and metres', () => {
    expect(boxClearedLevelFt([{ title: 'Altitude Clearance', info: 'FL140' }, { title: 'Squawk', info: '3711' }])).toBe(14000)
    expect(boxClearedLevelFt([{ title: 'climb', info: 'FL180' }])).toBe(18000)
    expect(boxClearedLevelFt([{ title: 'Climb', info: 'FL360' }])).toBe(36000)
    expect(boxClearedLevelFt([{ title: 'Descend to', info: '3,000m' }, { title: 'QNH', info: 'QNH 1014' }])).toBe(9843)
  })

  it('reads the ZJSY-VHHH titles: Continue Climb To, and a unitless Descend To in feet (2026-10-05)', () => {
    expect(boxClearedLevelFt([{ title: 'Continue Climb To', info: 'FL371' }])).toBe(37100)
    expect(boxClearedLevelFt([{ title: 'Descend To', info: '11,000' }, { title: 'QNH', info: 'QNH 1015' }])).toBe(11000)
    expect(boxClearedLevelFt([{ title: 'Cross CANTO', info: 'At or above FL130' }, { title: 'Descend To', info: '11,000' }])).toBe(11000)
  })

  it('ignores speeds and other boxes', () => {
    expect(boxClearedLevelFt([{ title: 'Maintain Speed', info: '250' }])).toBeNull()
    expect(boxClearedLevelFt([{ title: 'Cross SY498', info: 'At or above 1,200m' }])).toBeNull()
  })
})

describe('levelToFeet and withoutLabel', () => {
  it('converts levels and rejects anything else', () => {
    expect(levelToFeet('FL 95')).toBe(9500)
    expect(levelToFeet('11000 feet')).toBe(11000)
    expect(levelToFeet('1,200m')).toBe(3937)
    expect(levelToFeet('7000')).toBe(7000)
    expect(levelToFeet('Normal Speed')).toBeNull()
    expect(levelToFeet('0')).toBeNull()
  })

  it('strips a repeated label', () => {
    expect(withoutLabel('QNH 1014', 'QNH')).toBe('1014')
    expect(withoutLabel('1014', 'QNH')).toBe('1014')
  })
})
