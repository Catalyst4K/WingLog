import { describe, expect, it } from 'vitest'
import type { Flight } from '@shared/ipc'
import { lastKnownFuelOnBoard } from './fleet-fuel'

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 1,
    aircraftId: 1,
    simRegistration: null,
    simIcaoType: null,
    simTitle: null,
    status: 'completed',
    flightNumber: 'TA100',
    depIcao: 'EGLL',
    arrIcao: 'EGKK',
    altnIcao: null,
    routeString: null,
    cruiseAltM: null,
    schedOutUtc: null,
    schedInUtc: null,
    actualOutUtc: '2026-02-01T10:00:00.000Z',
    actualOffUtc: null,
    actualOnUtc: null,
    actualInUtc: '2026-02-01T11:05:00.000Z',
    blockMinutes: 65,
    airMinutes: null,
    fuelPlannedKg: null,
    fuelOutKg: null,
    fuelInKg: null,
    fuelBurnKg: null,
    pax: null,
    cargoKg: null,
    zfwKg: null,
    towKg: null,
    ldwKg: null,
    ofpId: null,
    ofpJson: null,
    simVersion: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    selectedDepartureRunway: null,
    selectedSidIdent: null,
    selectedSidTransition: null,
    selectedStarIdent: null,
    selectedStarTransition: null,
    selectedApproachIdent: null,
    selectedApproachTransition: null,
    selectedArrivalIcao: null,
    ...overrides
  }
}

describe('lastKnownFuelOnBoard', () => {
  it('returns the most recent completed flight when it has a real fuelInKg', () => {
    const flights = [
      makeFlight({ id: 2, arrIcao: 'VHHH', fuelInKg: 15357 }),
      makeFlight({ id: 1, arrIcao: 'EGKK', fuelInKg: 4000 })
    ]
    expect(lastKnownFuelOnBoard(flights)).toEqual(flights[0])
  })

  it('returns null when there are no completed flights at all', () => {
    expect(lastKnownFuelOnBoard([])).toBeNull()
  })

  it('returns null when the most recent flight has no fuelInKg, without falling back to an older one', () => {
    // Real case: an older CSV import with no captured fuel data. Falling back to an earlier
    // flight would silently show a stale number for the wrong flight.
    const flights = [
      makeFlight({ id: 2, arrIcao: 'VHHH', fuelInKg: null }),
      makeFlight({ id: 1, arrIcao: 'EGKK', fuelInKg: 4000 })
    ]
    expect(lastKnownFuelOnBoard(flights)).toBeNull()
  })
})
