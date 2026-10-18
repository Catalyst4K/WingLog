import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Aircraft, DispatchOfp, ProcedureSelection } from '@shared/ipc'
import { defaultDispatchOptions } from '@shared/dispatch-options'
import { flightFromOfp, planRequest, type PlanForm } from './use-dispatch-state'

function makeAircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    id: 7,
    registration: 'G-EUYB',
    icaoType: 'A320',
    operator: 'British Airways',
    operatorIata: 'BA',
    operatorIcao: 'BAW',
    simbriefAirframeId: '123456_1700000000000',
    simbriefType: null,
    simbriefAirframeDeveloper: null,
    simbriefAirframeEngines: null,
    simbriefAirframeRegistration: null,
    currentIcao: 'EGLL',
    createdAt: '2026-01-01T00:00:00.000Z',
    replacedByAircraftId: null,
    retiredAt: null,
    photoThumbnailUrl: null,
    ...overrides
  }
}

function makeForm(overrides: Partial<PlanForm> = {}): PlanForm {
  return {
    planAircraftId: 7,
    depIcao: 'EGLL',
    setDepIcao: vi.fn(),
    destIcao: 'LFPG',
    setDestIcao: vi.fn(),
    airlineIcao: 'BAW',
    setAirlineIcao: vi.fn(),
    flightNumber: '304',
    setFlightNumber: vi.fn(),
    departureUtc: new Date('2026-10-08T07:35:00Z'),
    setDepartureUtc: vi.fn(),
    dispatchOptions: { ...defaultDispatchOptions(), pax: '142', civalue: '30' },
    setDispatchOptions: vi.fn(),
    chooseAircraft: vi.fn(),
    reset: vi.fn(),
    ...overrides
  }
}

describe('planRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('builds the SimBrief request from the form and the chosen aircraft', () => {
    expect(planRequest(makeForm(), makeAircraft())).toEqual({
      origIcao: 'EGLL',
      destIcao: 'LFPG',
      icaoType: 'A320',
      simbriefAirframeId: '123456_1700000000000',
      simbriefType: null,
      airlineIcao: 'BAW',
      flightNumber: '304',
      departure: { dateEpochSeconds: Date.UTC(2026, 9, 8) / 1000, hour: 7, minute: 35 },
      extra: [
        ['pax', '142'],
        ['civalue', '30']
      ]
    })
  })

  it('sends null for a blank airline, flight number and departure time', () => {
    const request = planRequest(
      makeForm({
        airlineIcao: '',
        flightNumber: '',
        departureUtc: null,
        dispatchOptions: defaultDispatchOptions()
      }),
      makeAircraft({ simbriefAirframeId: null, simbriefType: 'A20N' })
    )
    expect(request).toMatchObject({
      simbriefAirframeId: null,
      simbriefType: 'A20N',
      airlineIcao: null,
      flightNumber: null,
      departure: null,
      extra: []
    })
  })
})

describe('flightFromOfp', () => {
  const ofp: DispatchOfp = {
    ofpId: '1759823700_ABC123',
    aircraftIcaoType: 'A320',
    aircraftRegistration: 'G-EUYB',
    flightNumber: 'BAW304',
    depIcao: 'EGLL',
    arrIcao: 'LFPG',
    altnIcao: 'LFPO',
    routeString: 'MODMI L9 KENET UL9 BIBAX',
    cruiseAltM: 10668,
    schedOutUtc: '2026-10-08T07:35:00Z',
    schedInUtc: '2026-10-08T08:50:00Z',
    fuelPlannedKg: 6120,
    pax: 142,
    cargoKg: 1850,
    zfwKg: 59800,
    towKg: 65600,
    ldwKg: 62700,
    costIndex: 30,
    waypoints: [],
    stepClimbs: [],
    ofpJson: '{"params":{}}',
    matchedAircraftId: 7,
    simbriefIsCustom: true,
    simbriefInternalId: '123456_1700000000000'
  }
  const selection: ProcedureSelection = {
    departureRunway: '27L',
    sidIdent: 'MODMI1J',
    sidTransition: null,
    starIdent: 'MOPAR5W',
    starTransition: null,
    approachIdent: 'ILS 27R',
    approachTransition: 'MOPAR',
    arrivalIcao: 'LFPG'
  }

  it('copies the OFP, the aircraft and every procedure choice into the new flight', () => {
    expect(flightFromOfp(ofp, 7, selection)).toEqual({
      aircraftId: 7,
      flightNumber: 'BAW304',
      depIcao: 'EGLL',
      arrIcao: 'LFPG',
      altnIcao: 'LFPO',
      routeString: 'MODMI L9 KENET UL9 BIBAX',
      cruiseAltM: 10668,
      schedOutUtc: '2026-10-08T07:35:00Z',
      schedInUtc: '2026-10-08T08:50:00Z',
      fuelPlannedKg: 6120,
      pax: 142,
      cargoKg: 1850,
      zfwKg: 59800,
      towKg: 65600,
      ldwKg: 62700,
      ofpId: '1759823700_ABC123',
      ofpJson: '{"params":{}}',
      selectedDepartureRunway: '27L',
      selectedSidIdent: 'MODMI1J',
      selectedSidTransition: null,
      selectedStarIdent: 'MOPAR5W',
      selectedStarTransition: null,
      selectedApproachIdent: 'ILS 27R',
      selectedApproachTransition: 'MOPAR',
      selectedArrivalIcao: 'LFPG'
    })
  })
})
