import { describe, expect, it } from 'vitest'
import { boxTaxiClearance } from './useTaxiRouteHighlight'

describe('boxTaxiClearance', () => {
  it('reads a departure clearance to a holding point (real VHHH boxes, 2026-10-05)', () => {
    expect(
      boxTaxiClearance([
        { title: 'Taxi to Runway', info: '07R' },
        ...['B', 'B', 'V', 'H', 'J'].map((info, i) => ({ title: `Taxi Via ${i + 1}`, info })),
        { title: 'Hold Position', info: 'J1' }
      ])
    ).toEqual({ taxiways: ['B', 'B', 'V', 'H', 'J'], holdingPoint: 'J1', stand: null, holdShortRunway: null })
  })

  it('reads an arrival clearance to a gate (real ZJSY boxes, 2026-10-05)', () => {
    expect(
      boxTaxiClearance([
        { title: 'Taxi to Gate', info: 'Gate 102' },
        { title: 'Taxi Via 1', info: 'A4' },
        { title: 'Taxi Via 2', info: 'D' }
      ])
    ).toEqual({ taxiways: ['A4', 'D'], holdingPoint: null, stand: '102', holdShortRunway: null })
  })

  it('treats a Hold Position naming a runway as a hold short, not a holding point', () => {
    expect(
      boxTaxiClearance([
        { title: 'Taxi Via 1', info: 'C7' },
        { title: 'Hold Position', info: '07C' }
      ])
    ).toMatchObject({ holdingPoint: null, holdShortRunway: '07C' })
  })

  it('is null when the boxes hold no taxi route', () => {
    expect(boxTaxiClearance([{ title: 'Expect Gate', info: 'Gate 102' }])).toBeNull()
    expect(boxTaxiClearance([])).toBeNull()
  })
})
