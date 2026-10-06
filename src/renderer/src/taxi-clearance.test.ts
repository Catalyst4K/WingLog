import { describe, expect, it } from 'vitest'
import { boxTaxiClearance, clearanceAirport, startOf, traceClearance } from './taxi-clearance'

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

describe('startOf', () => {
  it('starts from the aircraft, with its heading only while taxiing under its own power', () => {
    const at = { lat: 22.3089, lon: 113.9146, headingDeg: 71 }
    expect(startOf(at, 'taxi')).toEqual({ from: { lat: 22.3089, lon: 113.9146 }, headingDeg: 71 })
    expect(startOf(at, 'pushback')).toEqual({ from: { lat: 22.3089, lon: 113.9146 }, headingDeg: null })
    expect(startOf(null, 'taxi')).toEqual({ from: null, headingDeg: null })
  })
})

describe('clearanceAirport', () => {
  const clearance = { taxiways: ['C7'], holdingPoint: null, stand: null, holdShortRunway: null, from: { lat: 22.31, lon: 113.91 } }
  const segment = (lat: number, lon: number) =>
    ({ startLat: lat, startLon: lon, endLat: lat, endLon: lon, name: 'C7', startHoldShort: false, endHoldShort: false }) as never
  const networks = { VHHH: [segment(22.31, 113.91)], ZJSY: [segment(18.3, 109.4)] }

  it('puts a holding point at the departure and a stand at the arrival', () => {
    expect(clearanceAirport({ ...clearance, holdingPoint: 'J1' }, 'VHHH', 'ZJSY', networks)).toBe('VHHH')
    expect(clearanceAirport({ ...clearance, stand: '102' }, 'VHHH', 'ZJSY', networks)).toBe('ZJSY')
  })

  it('puts a hold short at whichever airport is nearest the aircraft', () => {
    expect(clearanceAirport({ ...clearance, holdShortRunway: '07C' }, 'ZJSY', 'VHHH', networks)).toBe('VHHH')
    expect(clearanceAirport({ ...clearance, holdShortRunway: '07C' }, 'VHHH', 'ZJSY', networks)).toBe('VHHH')
    expect(clearanceAirport({ ...clearance, holdShortRunway: '07C' }, 'VHHH', 'ZJSY', {})).toBe('ZJSY')
  })
})

describe('traceClearance', () => {
  it('traces nothing before the aircraft position is known', () => {
    expect(traceClearance({ taxiways: ['A'], holdingPoint: 'A1', stand: null, holdShortRunway: null, from: null }, [], null)).toBeNull()
  })
})
