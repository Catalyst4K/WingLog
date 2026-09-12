import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  Aircraft,
  Flight,
  Landing,
  LandingScoreCategory,
  LandingScoreCategoryKey,
  LandingScoreResult,
  LandingScoreSummary,
  WingLogApi
} from '@shared/ipc'
import { LandingCard, LogbookView } from './LogbookView'

afterEach(() => {
  vi.clearAllMocks()
})

function makeAircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    id: 1,
    registration: 'G-ONE',
    icaoType: 'A320',
    operator: 'Test Air',
    operatorIata: 'TA',
    operatorIcao: 'TST',
    simbriefAirframeId: null,
    simbriefType: null,
    simbriefAirframeDeveloper: null,
    simbriefAirframeEngines: null,
    simbriefAirframeRegistration: null,
    currentIcao: 'EGLL',
    createdAt: '2026-01-01T00:00:00.000Z',
    replacedByAircraftId: null,
    photoThumbnailUrl: null,
    ...overrides
  }
}

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 1,
    aircraftId: 1,
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
    actualInUtc: '2026-02-01T12:00:00.000Z',
    blockMinutes: 120,
    airMinutes: 100,
    fuelPlannedKg: null,
    fuelOutKg: null,
    fuelInKg: null,
    fuelBurnKg: 4000,
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
    ...overrides
  }
}

function makeLanding(overrides: Partial<Landing> = {}): Landing {
  return {
    id: 1,
    flightId: 1,
    touchdownTsUtc: '2026-02-01T12:00:00.000Z',
    verticalSpeedMs: -1.5,
    gForce: 1.2,
    pitchDeg: 3,
    bankDeg: 0,
    headingTrueDeg: 270,
    indicatedAirspeedMs: 70,
    groundSpeedMs: 70,
    windSpeedMs: 5,
    windDirectionDeg: 260,
    headwindMs: 4,
    crosswindMs: 2,
    crabDeg: 1,
    runwayIdent: '27L',
    distanceFromThresholdM: 300,
    centrelineOffsetM: 1,
    flapSetting: 3,
    touchdownSource: 'derived',
    ...overrides
  }
}

const CATEGORY_LABELS: Record<LandingScoreCategoryKey, string> = {
  verticalSpeed: 'Vertical speed',
  gForce: 'G-force',
  pitch: 'Pitch',
  bank: 'Bank',
  crab: 'Crab',
  distanceFromAimingPoint: 'Distance from aiming point',
  centrelineOffset: 'Centreline offset'
}

// Real weights (landing-score.ts's WEIGHTS) — the popup scales each row by its own weight.
const CATEGORY_WEIGHTS: Record<LandingScoreCategoryKey, number> = {
  verticalSpeed: 25,
  gForce: 15,
  distanceFromAimingPoint: 20,
  centrelineOffset: 10,
  pitch: 10,
  bank: 10,
  crab: 10
}

function makeCategories(overrides: Partial<Record<LandingScoreCategoryKey, number | null>> = {}): LandingScoreCategory[] {
  const scores: Record<LandingScoreCategoryKey, number | null> = {
    verticalSpeed: 90,
    gForce: 95,
    pitch: 90,
    bank: 95,
    crab: 90,
    distanceFromAimingPoint: 85,
    centrelineOffset: 90,
    ...overrides
  }
  return (Object.keys(scores) as LandingScoreCategoryKey[]).map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    score: scores[key],
    weight: CATEGORY_WEIGHTS[key]
  }))
}

function buildWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  return {
    logbookListCompletedFlights: vi.fn().mockResolvedValue([]),
    aircraftList: vi.fn().mockResolvedValue([]),
    logbookGetStats: vi.fn().mockResolvedValue({ totalFlights: 0, totalBlockMinutes: 0, totalNm: 0 }),
    logbookListFlightScores: vi.fn().mockResolvedValue([]),
    ...overrides
  } as WingLogApi
}

function setWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = buildWinglog(overrides)
  window.winglog = api
  return api
}

describe('LogbookView list', () => {
  it('shows a Score column instead of Air, with the value from logbookListFlightScores', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ id: 1 })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([{ flightId: 1, score: 87 } satisfies LandingScoreSummary])
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)

    expect(await screen.findByText('87')).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Air' })).not.toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Landing Score' })).toBeInTheDocument()
  })

  it('shows a dash for a completed flight with no landing row', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ id: 1 })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([])
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)

    await screen.findByText('EGLL', { exact: false })
    const row = screen.getByText('TA100').closest('tr')!
    expect(within(row).getByText('—')).toBeInTheDocument()
  })

  it('sorts by score, treating a missing score the same as zero', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([
        makeFlight({ id: 1, flightNumber: 'HIGH', actualOutUtc: '2026-02-01T10:00:00.000Z' }),
        makeFlight({ id: 2, flightNumber: 'LOW', actualOutUtc: '2026-02-02T10:00:00.000Z' }),
        makeFlight({ id: 3, flightNumber: 'NONE', actualOutUtc: '2026-02-03T10:00:00.000Z' })
      ]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([
        { flightId: 1, score: 95 },
        { flightId: 2, score: 10 }
      ] satisfies LandingScoreSummary[])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await screen.findByText('HIGH')

    await user.click(screen.getByRole('columnheader', { name: 'Landing Score' }))
    const rowsAsc = screen.getAllByRole('row').slice(1) // drop the header row
    // Ascending by score, missing (NONE) treated as 0: NONE(0), LOW(10), HIGH(95).
    expect(within(rowsAsc[0]).getByText('NONE')).toBeInTheDocument()
    expect(within(rowsAsc[1]).getByText('LOW')).toBeInTheDocument()
    expect(within(rowsAsc[2]).getByText('HIGH')).toBeInTheDocument()

    await user.click(screen.getByRole('columnheader', { name: 'Landing Score' }))
    const rowsDesc = screen.getAllByRole('row').slice(1)
    expect(within(rowsDesc[0]).getByText('HIGH')).toBeInTheDocument()
  })
})

describe('LandingCard', () => {
  it('renders the fetched score and severity', async () => {
    setWinglog({
      logbookGetLanding: vi.fn().mockResolvedValue(makeLanding()),
      logbookGetLandingRunway: vi.fn().mockResolvedValue(null),
      logbookGetLandingScore: vi
        .fn()
        .mockResolvedValue({ score: 78, severity: 'firm', categories: makeCategories() } satisfies LandingScoreResult)
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    expect(await screen.findByText('78')).toBeInTheDocument()
    expect(screen.getByText('Firm')).toBeInTheDocument()
  })

  it('renders nothing extra when the flight has no landing row', async () => {
    setWinglog({
      logbookGetLanding: vi.fn().mockResolvedValue(null),
      logbookGetLandingRunway: vi.fn().mockResolvedValue(null),
      logbookGetLandingScore: vi.fn().mockResolvedValue(null)
    })
    const { container } = render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('shows a dash for the score while none/hard badge is absent for a "none" severity landing', async () => {
    setWinglog({
      logbookGetLanding: vi.fn().mockResolvedValue(makeLanding()),
      logbookGetLandingRunway: vi.fn().mockResolvedValue(null),
      logbookGetLandingScore: vi.fn().mockResolvedValue(null)
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    await screen.findByText('Touchdown rate')
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('Firm')).not.toBeInTheDocument()
    expect(screen.queryByText('Hard')).not.toBeInTheDocument()
  })

  it('shows a warning icon next to a field whose own category scored badly, not next to a good one', async () => {
    setWinglog({
      logbookGetLanding: vi.fn().mockResolvedValue(makeLanding()),
      logbookGetLandingRunway: vi.fn().mockResolvedValue(null),
      logbookGetLandingScore: vi.fn().mockResolvedValue({
        score: 55,
        severity: 'none',
        categories: makeCategories({ crab: 10, pitch: 95 })
      } satisfies LandingScoreResult)
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    const crabRow = await screen.findByText('Crab')
    const pitchRow = screen.getByText('Pitch')
    expect(crabRow.closest('dt')!.querySelector('svg')).not.toBeNull()
    expect(pitchRow.closest('dt')!.querySelector('svg')).toBeNull()
  })

  it('opens the score breakdown dialog from the card header button', async () => {
    const user = userEvent.setup()
    setWinglog({
      logbookGetLanding: vi.fn().mockResolvedValue(makeLanding()),
      logbookGetLandingRunway: vi.fn().mockResolvedValue(null),
      logbookGetLandingScore: vi.fn().mockResolvedValue({
        score: 55,
        severity: 'none',
        categories: makeCategories({ crab: 10 })
      } satisfies LandingScoreResult)
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    const trigger = await screen.findByRole('button', { name: 'Score breakdown' })
    expect(screen.queryByText(/Landing score breakdown —/)).not.toBeInTheDocument()

    await user.click(trigger)
    expect(screen.getByText('Landing score breakdown — 55/100')).toBeInTheDocument()
  })
})
