import { describe, expect, it } from 'vitest'
import type { LandingListRow, LogbookFlight } from '@shared/ipc'
import {
  compareFlights,
  compareLandingRows,
  LANDING_SORT_KEYS,
  SORT_KEYS,
  type LandingSortKey,
  type SortKey
} from './sorting'

const baseFlight: LogbookFlight = {
  id: 1,
  aircraftId: 1,
  simRegistration: null,
  simIcaoType: null,
  simTitle: null,
  status: 'completed',
  flightNumber: 'BAW304',
  depIcao: 'EGLL',
  arrIcao: 'LFPG',
  altnIcao: null,
  routeString: null,
  cruiseAltM: null,
  schedOutUtc: null,
  schedInUtc: null,
  actualOutUtc: '2026-10-01T07:35:00.000Z',
  actualOffUtc: null,
  actualOnUtc: null,
  actualInUtc: '2026-10-01T08:50:00.000Z',
  blockMinutes: 75,
  airMinutes: 58,
  fuelPlannedKg: null,
  fuelOutKg: null,
  fuelInKg: null,
  fuelBurnKg: 2400,
  pax: null,
  cargoKg: null,
  zfwKg: null,
  towKg: null,
  ldwKg: null,
  ofpId: null,
  simVersion: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  selectedDepartureRunway: null,
  selectedSidIdent: null,
  selectedSidTransition: null,
  selectedStarIdent: null,
  selectedStarTransition: null,
  selectedApproachIdent: null,
  selectedApproachTransition: null,
  selectedArrivalIcao: null,
  hasOfp: true
}

function flight(overrides: Partial<LogbookFlight>): LogbookFlight {
  return { ...baseFlight, ...overrides }
}

const registrations: Record<number, string> = { 1: 'G-EUYB', 2: 'G-XWBA' }
const scores: Record<number, number> = { 1: 92, 2: 71 }
const registrationFor = (f: LogbookFlight): string => registrations[f.id] ?? '—'
const scoreFor = (id: number): number | null => scores[id] ?? null

describe('compareFlights', () => {
  const earlier = flight({ id: 1 })
  const later = flight({
    id: 2,
    flightNumber: 'VIR9',
    depIcao: 'EGLL',
    arrIcao: 'KJFK',
    actualOutUtc: '2026-10-05T09:00:00.000Z',
    blockMinutes: 480,
    fuelBurnKg: 52000
  })

  it.each<SortKey>(SORT_KEYS)('puts the smaller %s first and the larger last', (key) => {
    // The second flight is larger in every column but two: its route (EGLLKJFK) sorts before
    // the first's (EGLLLFPG), and its lookup score (71) is below the first's (92).
    const ascending = key === 'route' || key === 'score' ? [later, earlier] : [earlier, later]
    const [first, second] = ascending
    expect(compareFlights(first, second, key, registrationFor, scoreFor)).toBeLessThan(0)
    expect(compareFlights(second, first, key, registrationFor, scoreFor)).toBeGreaterThan(0)
    expect(compareFlights(first, first, key, registrationFor, scoreFor)).toBe(0)
  })

  it('treats missing date, flight number, block time and fuel as empty or zero', () => {
    const blank = flight({
      id: 3,
      actualOutUtc: null,
      flightNumber: null,
      blockMinutes: null,
      fuelBurnKg: null
    })
    for (const key of ['date', 'flight', 'block', 'fuel'] as const) {
      expect(compareFlights(blank, earlier, key, registrationFor, scoreFor)).toBeLessThan(0)
    }
  })

  it('sorts a flight with no landing score alongside a genuine zero', () => {
    const unscored = flight({ id: 99 })
    expect(compareFlights(unscored, earlier, 'score', registrationFor, scoreFor)).toBeLessThan(0)
    expect(compareFlights(unscored, flight({ id: 98 }), 'score', registrationFor, scoreFor)).toBe(0)
  })

  it('orders the route by departure then arrival', () => {
    const toParis = flight({ depIcao: 'EGLL', arrIcao: 'LFPG' })
    const toNewYork = flight({ depIcao: 'EGLL', arrIcao: 'KJFK' })
    expect(compareFlights(toNewYork, toParis, 'route', registrationFor, scoreFor)).toBeLessThan(0)
  })
})

const baseLanding: LandingListRow = {
  id: 1,
  flightId: 1,
  seq: 1,
  icao: 'LFPG',
  touchdownTsUtc: '2026-10-01T08:45:00.000Z',
  verticalSpeedMs: -1.2,
  gForce: 1.15,
  pitchDeg: 3,
  bankDeg: 0.5,
  headingTrueDeg: 267,
  indicatedAirspeedMs: 69,
  groundSpeedMs: 66,
  windSpeedMs: 6,
  windDirectionDeg: 250,
  headwindMs: 5,
  crosswindMs: 2,
  crabDeg: 1,
  runwayIdent: '26R',
  distanceFromThresholdM: 320,
  centrelineOffsetM: 1,
  flapSetting: 4,
  touchdownSource: 'derived',
  flightNumber: 'BAW304',
  aircraftRegistration: 'G-EUYB',
  depIcao: 'EGLL',
  arrIcao: 'LFPG',
  score: 92,
  severity: null
}

function landing(overrides: Partial<LandingListRow>): LandingListRow {
  return { ...baseLanding, ...overrides }
}

describe('compareLandingRows', () => {
  const smaller = landing({
    id: 1,
    touchdownTsUtc: '2026-10-01T08:45:00.000Z',
    aircraftRegistration: 'G-EUYB',
    icao: 'EGLL',
    runwayIdent: '27L',
    flightNumber: 'BAW304',
    verticalSpeedMs: -2.4,
    gForce: 1.05,
    score: 60
  })
  const larger = landing({
    id: 2,
    touchdownTsUtc: '2026-10-06T14:10:00.000Z',
    aircraftRegistration: 'G-XWBA',
    icao: 'LFPG',
    runwayIdent: '26R',
    flightNumber: 'VIR9',
    verticalSpeedMs: -0.9,
    gForce: 1.4,
    score: 95
  })

  it.each<LandingSortKey>(LANDING_SORT_KEYS)('puts the smaller %s first and the larger last', (key) => {
    expect(compareLandingRows(smaller, larger, key)).toBeLessThan(0)
    expect(compareLandingRows(larger, smaller, key)).toBeGreaterThan(0)
    expect(compareLandingRows(smaller, smaller, key)).toBe(0)
  })

  it('treats a missing flight number, airport, runway and score as empty or zero', () => {
    const blank = landing({ flightNumber: null, icao: null, runwayIdent: null, score: null })
    expect(compareLandingRows(blank, smaller, 'flight')).toBeLessThan(0)
    expect(compareLandingRows(blank, smaller, 'airport')).toBeLessThan(0)
    expect(compareLandingRows(blank, smaller, 'score')).toBeLessThan(0)
    expect(compareLandingRows(blank, landing({ score: 0 }), 'score')).toBe(0)
  })

  it('orders the airport by ICAO code then runway', () => {
    const left = landing({ icao: 'LFPG', runwayIdent: '08L' })
    const right = landing({ icao: 'LFPG', runwayIdent: '26R' })
    expect(compareLandingRows(left, right, 'airport')).toBeLessThan(0)
  })
})
