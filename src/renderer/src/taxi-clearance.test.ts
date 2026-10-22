import type { NavdataTaxiSegment } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import {
  boxTaxiClearance,
  clearanceAirport,
  clearanceRequest,
  startOf,
  traceClearance
} from './taxi-clearance'

describe('boxTaxiClearance', () => {
  it('reads a departure clearance to a holding point (real VHHH boxes, 2026-10-05)', () => {
    expect(
      boxTaxiClearance([
        { title: 'Taxi to Runway', info: '07R' },
        ...['B', 'B', 'V', 'H', 'J'].map((info, i) => ({ title: `Taxi Via ${i + 1}`, info })),
        { title: 'Hold Position', info: 'J1' }
      ])
    ).toEqual({
      taxiways: ['B', 'B', 'V', 'H', 'J'],
      holdingPoint: 'J1',
      stand: null,
      holdShortRunway: null,
      taxiToRunway: '07R'
    })
  })

  it('reads an arrival clearance to a gate (real ZJSY boxes, 2026-10-05)', () => {
    expect(
      boxTaxiClearance([
        { title: 'Taxi to Gate', info: 'Gate 102' },
        { title: 'Taxi Via 1', info: 'A4' },
        { title: 'Taxi Via 2', info: 'D' }
      ])
    ).toEqual({
      taxiways: ['A4', 'D'],
      holdingPoint: null,
      stand: '102',
      holdShortRunway: null,
      taxiToRunway: null
    })
  })

  it('treats a Hold Position naming a runway as a hold short, not a holding point', () => {
    expect(
      boxTaxiClearance([
        { title: 'Taxi Via 1', info: 'C7' },
        { title: 'Hold Position', info: '07C' }
      ])
    ).toMatchObject({ holdingPoint: null, holdShortRunway: '07C' })
  })

  it('reads the first half of a runway crossing from the Hold Short box alone, with no speech (real EGLL boxes, flight 239, 2026-10-15)', () => {
    // Before this the clearance had no end: it was taken for the arrival's, drawn nowhere, and only the spoken "hold short" (which the
    // phone never gets) made the desktop's line appear.
    expect(
      boxTaxiClearance([
        { title: 'Taxi to Runway', info: '27R' },
        { title: 'Taxi Via 1', info: 'LINK 44' },
        { title: 'Taxi Via 2', info: 'T' },
        { title: 'Taxi Via 3', info: 'S' },
        { title: 'Hold Short', info: '27L' }
      ])
    ).toEqual({
      taxiways: ['LINK 44', 'T', 'S'],
      holdingPoint: null,
      stand: null,
      holdShortRunway: '27L',
      taxiToRunway: '27R'
    })
  })

  it('is null when the boxes hold no taxi route', () => {
    expect(boxTaxiClearance([{ title: 'Expect Gate', info: 'Gate 102' }])).toBeNull()
    expect(boxTaxiClearance([])).toBeNull()
  })
})

describe('startOf', () => {
  it('starts from the aircraft, and keeps which way its nose points when that is known', () => {
    expect(startOf({ lat: 22.3089, lon: 113.9146 })).toEqual({ from: { lat: 22.3089, lon: 113.9146 } })
    expect(startOf({ lat: 22.3268, lon: 113.9019, headingDeg: 100.7 })).toEqual({
      from: { lat: 22.3268, lon: 113.9019, headingDeg: 100.7 }
    })
    expect(startOf(null)).toEqual({ from: null })
  })
})

describe('clearanceRequest', () => {
  const clearance = {
    taxiways: ['C7', 'C', 'D', 'C', 'F'],
    holdingPoint: null,
    stand: null,
    holdShortRunway: '07C',
    taxiToRunway: null
  }

  it('starts the trace the way the nose pointed when the clearance arrived (VHHH flight 253: 101°, east along C)', () => {
    const request = clearanceRequest(
      { ...clearance, from: { lat: 22.3268, lon: 113.9019, headingDeg: 100.7 } },
      [],
      null
    )
    expect(request?.from).toEqual({ lat: 22.3268, lon: 113.9019 })
    expect(request?.headingDeg).toBe(100.7)
  })

  it('has no preference when the heading is not known', () => {
    expect(
      clearanceRequest({ ...clearance, from: { lat: 22.3268, lon: 113.9019 } }, [], null)?.headingDeg
    ).toBeNull()
  })
})

describe('clearanceAirport', () => {
  const clearance = {
    taxiways: ['C7'],
    holdingPoint: null,
    stand: null,
    holdShortRunway: null,
    taxiToRunway: null,
    from: { lat: 22.31, lon: 113.91 }
  }
  const segment = (lat: number, lon: number) =>
    ({
      startLat: lat,
      startLon: lon,
      endLat: lat,
      endLon: lon,
      name: 'C7',
      startHoldShort: false,
      endHoldShort: false
    }) as never
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

describe('boxTaxiClearance with the departure clearance boxes (VHHH 2026-10-15, EGLL 2026-10-11)', () => {
  it('is not a taxi clearance: a Taxi to Runway box with a SID and no Taxi Via is the clearance delivery, not the taxi instruction', () => {
    expect(
      boxTaxiClearance([
        { title: 'Taxi to Runway', info: '07R' },
        { title: 'SID', info: 'PECA3X' },
        { title: 'Altitude Clearance', info: 'FL140' },
        { title: 'Squawk', info: '0103' }
      ])
    ).toBeNull()
  })
})

describe('boxTaxiClearance with only the Taxi to Runway and Taxi Via boxes (WSSS 2026-10-19)', () => {
  it('takes the last taxiway as the holding point, for the runway named', () => {
    expect(
      boxTaxiClearance([
        { title: 'Taxi to Runway', info: '02C' },
        { title: 'Taxi Via 1', info: 'P' },
        { title: 'Taxi Via 2', info: 'T' }
      ])
    ).toEqual({
      taxiways: ['P', 'T'],
      holdingPoint: 'T',
      stand: null,
      holdShortRunway: null,
      taxiToRunway: '02C'
    })
  })

  it("is the departure airport's clearance: the line is looked for on the departure's taxi network, not the arrival's (the WSSS no-line bug)", () => {
    const box = boxTaxiClearance([
      { title: 'Taxi to Runway', info: '02C' },
      { title: 'Taxi Via 1', info: 'P' },
      { title: 'Taxi Via 2', info: 'T' }
    ])!
    const clearance = { ...box, from: { lat: 1.363, lon: 103.995 } }
    expect(clearanceAirport(clearance, 'WSSS', 'EGLL', {})).toBe('WSSS')
  })

  it('leaves a clearance with a Hold Short, Hold Position or gate as it was', () => {
    const via = [
      { title: 'Taxi to Runway', info: '27R' },
      { title: 'Taxi Via 1', info: 'S' }
    ]
    expect(boxTaxiClearance([...via, { title: 'Hold Short', info: '27L' }])).toMatchObject({
      holdingPoint: null,
      holdShortRunway: '27L'
    })
    expect(boxTaxiClearance([...via, { title: 'Hold Position', info: 'A1' }])).toMatchObject({
      holdingPoint: 'A1'
    })
    expect(boxTaxiClearance([{ title: 'Taxi to Gate', info: 'Gate 102' }, ...via.slice(1)])).toMatchObject({
      holdingPoint: null,
      stand: '102'
    })
  })
})

describe('traceClearance', () => {
  it('traces nothing before the aircraft position is known', () => {
    expect(
      traceClearance(
        {
          taxiways: ['A'],
          holdingPoint: 'A1',
          stand: null,
          holdShortRunway: null,
          taxiToRunway: null,
          from: null
        },
        [],
        null
      )
    ).toBeNull()
  })

  it('traces from the first taxiway when the aircraft is already past the clearance start (EGCC 2026-10-18)', () => {
    const seg = (a: [number, number], b: [number, number], name: string): NavdataTaxiSegment => ({
      startLat: a[0],
      startLon: a[1],
      endLat: b[0],
      endLon: b[1],
      name,
      startHoldShort: false,
      endHoldShort: false
    })
    const segments = [
      seg([53.344, -2.284], [53.349, -2.28], 'VC'),
      seg([53.349, -2.28], [53.35, -2.279], 'V'),
      seg([53.35, -2.279], [53.353, -2.2815], 'A')
    ]
    const route = traceClearance(
      {
        taxiways: ['VC', 'V', 'A'],
        holdingPoint: null,
        stand: null,
        holdShortRunway: null,
        taxiToRunway: null,
        from: { lat: 53.353, lon: -2.2815 }
      },
      segments,
      null
    )
    expect(route?.[0]).toEqual([-2.284, 53.344])
  })

  it("follows a taxiway the sim splits into numbered pieces, so the line starts at the aircraft (ZUCK 2026-10-20: 'via M, G, H1' with M1 and M2)", () => {
    const seg = (
      a: [number, number],
      b: [number, number],
      name: string,
      holdShort = false
    ): NavdataTaxiSegment => ({
      startLat: a[0],
      startLon: a[1],
      endLat: b[0],
      endLon: b[1],
      name,
      startHoldShort: false,
      endHoldShort: holdShort
    })
    // The apron (M2, M1), the parallel taxiway G, then H1 to the runway's hold short: no segment is named just "M".
    const segments = [
      seg([29.727, 106.655], [29.7275, 106.6556], 'M2'),
      seg([29.7275, 106.6556], [29.7275, 106.66], 'M1'),
      seg([29.7275, 106.66], [29.72, 106.66], 'G'),
      seg([29.72, 106.66], [29.715, 106.66], 'G'),
      seg([29.715, 106.66], [29.715, 106.662], 'H1', true)
    ]
    const route = traceClearance(
      {
        taxiways: ['M', 'G', 'H1'],
        holdingPoint: 'H1',
        stand: null,
        holdShortRunway: null,
        taxiToRunway: '03L',
        from: { lat: 29.727, lon: 106.655 }
      },
      segments,
      null
    )
    expect(route?.[0]).toEqual([106.655, 29.727])
    expect(route?.at(-1)).toEqual([106.662, 29.715])
  })
})
