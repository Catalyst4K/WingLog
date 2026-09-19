import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import type {
  Aircraft,
  Flight,
  Landing,
  LandingListRow,
  LandingScoreCategory,
  LandingScoreCategoryKey,
  LandingScoreResult,
  LandingScoreSummary,
  LandingWithDetails,
  TrackPoint,
  WingLogApi
} from '@shared/ipc'
import { LandingCard, LandingsTable, landingLabels, LogbookView } from './LogbookView'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

// FlightDetail renders a real FlightMap, which constructs a real maplibre-gl map needing a
// canvas/WebGL context jsdom doesn't provide — same reason FlightMap.test.tsx/App.test.tsx
// mock this module. Deliberately minimal: nothing here asserts against the map itself.
vi.mock('maplibre-gl', () => {
  class FakeHandler {
    enable = vi.fn()
    disable = vi.fn()
    disableRotation = vi.fn()
  }
  class FakeMap {
    container: HTMLElement
    dragPan = new FakeHandler()
    keyboard = new FakeHandler()
    scrollZoom = new FakeHandler()
    touchZoomRotate = new FakeHandler()
    doubleClickZoom = new FakeHandler()
    fitBounds = vi.fn()
    jumpTo = vi.fn()
    easeTo = vi.fn()
    zoomIn = vi.fn()
    zoomOut = vi.fn()
    remove = vi.fn()
    setLayoutProperty = vi.fn()
    constructor(options: { container: HTMLElement }) {
      this.container = options.container
    }
    on(event: string, cb: () => void): void {
      if (event === 'style.load') queueMicrotask(cb)
    }
    off(): void {}
    addSource(): void {}
    addLayer(): void {}
    getSource(): { setData: () => void } {
      return { setData: vi.fn() }
    }
    getCenter(): { toArray: () => [number, number] } {
      return { toArray: () => [0, 0] }
    }
    getZoom(): number {
      return 1
    }
  }
  class FakeMarker {
    private el: HTMLElement
    constructor(opts: { element: HTMLElement }) {
      this.el = opts.element
    }
    setLngLat(): void {}
    setRotation(): void {}
    getElement(): HTMLElement {
      return this.el
    }
    addTo(map: FakeMap): this {
      map.container.appendChild(this.el)
      return this
    }
    remove(): this {
      this.el.remove()
      return this
    }
  }
  return {
    Map: FakeMap,
    Marker: FakeMarker,
    LngLatBounds: class {
      extend(): this {
        return this
      }
    },
    GeoJSONSource: class {},
    setWorkerUrl: vi.fn()
  }
})

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob()) }))
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:mock')
    }
  )
  // recharts' ResponsiveContainer measures via ResizeObserver, which jsdom doesn't
  // implement — a no-op stub is enough for the chart cards themselves (title, mode toggle)
  // to render; the actual chart canvas staying unmeasured/empty doesn't affect anything
  // these tests assert on.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

function makeTrackPoint(overrides: Partial<TrackPoint> = {}): TrackPoint {
  return {
    id: 1,
    flightId: 1,
    tsUtc: '2026-02-01T10:00:00.000Z',
    latitude: 51.4775,
    longitude: -0.4614,
    altitudeM: 1000,
    pressureAltitudeM: null,
    altitudeAglM: 1000,
    indicatedAirspeedMs: 100,
    machSpeed: 0.3,
    groundSpeedMs: 100,
    verticalSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    phase: 'cruise',
    onGround: false,
    fuelKg: 5000,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    resumeSegment: 0,
    simRate: 1,
    excludedReason: null,
    ...overrides
  }
}

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
    retiredAt: null,
    photoThumbnailUrl: null,
    ...overrides
  }
}

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
    selectedArrivalIcao: null,
    ...overrides
  }
}

function makeLanding(overrides: Partial<Landing> = {}): Landing {
  return {
    id: 1,
    flightId: 1,
    seq: 1,
    icao: 'EGKK',
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

function makeLandingWithDetails(overrides: Partial<LandingWithDetails> = {}): LandingWithDetails {
  return {
    ...makeLanding(),
    runway: null,
    score: null,
    ...overrides
  }
}

function makeLandingListRow(overrides: Partial<LandingListRow> = {}): LandingListRow {
  return {
    ...makeLanding(),
    flightNumber: 'TA100',
    aircraftRegistration: 'G-ONE',
    depIcao: 'EGLL',
    arrIcao: 'EGKK',
    score: null,
    severity: null,
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

function makeCategories(
  overrides: Partial<Record<LandingScoreCategoryKey, number | null>> = {}
): LandingScoreCategory[] {
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
    ideal: scores[key] === null ? null : 0,
    tolerance: scores[key] === null ? null : 10
  }))
}

function buildWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  return {
    logbookListCompletedFlights: vi.fn().mockResolvedValue([]),
    aircraftList: vi.fn().mockResolvedValue([]),
    logbookGetStats: vi.fn().mockResolvedValue({ totalFlights: 0, totalBlockMinutes: 0, totalNm: 0 }),
    logbookListFlightScores: vi.fn().mockResolvedValue([]),
    // FlightDetail (opened from the list)
    trackPointList: vi.fn().mockResolvedValue([]),
    logbookListLandings: vi.fn().mockResolvedValue([]),
    logbookListAllLandings: vi.fn().mockResolvedValue([]),
    logbookGreatCircleRoute: vi.fn().mockResolvedValue(null),
    logbookOpenOfpPdf: vi.fn().mockResolvedValue(true),
    flightDelete: vi.fn().mockResolvedValue(undefined),
    trackPointCleanup: vi.fn().mockResolvedValue({ excludedCount: 0, resegmentedCount: 0 }),
    // GsxInvoicesCard, mounted unconditionally inside FlightDetail
    logbookListInvoices: vi.fn().mockResolvedValue([]),
    settingsGetGsx: vi.fn().mockResolvedValue({ enabled: false, folderPath: null, displayCurrency: 'USD' }),
    fxGetRate: vi.fn().mockResolvedValue(null),
    gsxRescanFlight: vi.fn().mockResolvedValue({ invoices: [], notailCandidates: [] }),
    gsxAttachNotailReceipt: vi.fn().mockResolvedValue([]),
    gsxOpenReceipt: vi.fn().mockResolvedValue(undefined),
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
      logbookListFlightScores: vi
        .fn()
        .mockResolvedValue([{ flightId: 1, score: 87, landingCount: 1 } satisfies LandingScoreSummary])
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
      logbookListCompletedFlights: vi
        .fn()
        .mockResolvedValue([
          makeFlight({ id: 1, flightNumber: 'HIGH', actualOutUtc: '2026-02-01T10:00:00.000Z' }),
          makeFlight({ id: 2, flightNumber: 'LOW', actualOutUtc: '2026-02-02T10:00:00.000Z' }),
          makeFlight({ id: 3, flightNumber: 'NONE', actualOutUtc: '2026-02-03T10:00:00.000Z' })
        ]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([
        { flightId: 1, score: 95, landingCount: 1 },
        { flightId: 2, score: 10, landingCount: 1 }
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

  it('shows a ×N badge next to the score for a flight with more than one landing, and none for exactly one', async () => {
    setWinglog({
      logbookListCompletedFlights: vi
        .fn()
        .mockResolvedValue([
          makeFlight({ id: 1, flightNumber: 'CIRCUITS' }),
          makeFlight({ id: 2, flightNumber: 'SINGLE' })
        ]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([
        { flightId: 1, score: 80, landingCount: 3 },
        { flightId: 2, score: 90, landingCount: 1 }
      ] satisfies LandingScoreSummary[])
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)

    const circuitsRow = (await screen.findByText('CIRCUITS')).closest('tr')!
    expect(within(circuitsRow).getByText('×3')).toBeInTheDocument()
    const singleRow = screen.getByText('SINGLE').closest('tr')!
    expect(within(singleRow).queryByText(/×/)).not.toBeInTheDocument()
  })

  it('shows a Free flight badge for a flight tracked with no OFP and a real liftoff, not for a dispatched one', async () => {
    setWinglog({
      logbookListCompletedFlights: vi
        .fn()
        .mockResolvedValue([
          makeFlight({
            id: 1,
            flightNumber: 'FREE1',
            ofpJson: null,
            actualOffUtc: '2026-02-01T10:05:00.000Z'
          }),
          makeFlight({ id: 2, flightNumber: 'DISPATCHED', ofpJson: '{}' })
        ]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([])
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)

    const freeRow = (await screen.findByText('FREE1')).closest('tr')!
    expect(within(freeRow).getByText('Free flight')).toBeInTheDocument()
    const dispatchedRow = screen.getByText('DISPATCHED').closest('tr')!
    expect(within(dispatchedRow).queryByText('Free flight')).not.toBeInTheDocument()
  })

  it("shows the flight's own sim-reported registration for a free flight tracked with no fleet aircraft — not mandatory to add one", async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([
        makeFlight({
          id: 1,
          flightNumber: 'FREE1',
          aircraftId: null,
          simRegistration: 'G-TEST',
          simIcaoType: 'C172',
          ofpJson: null,
          actualOffUtc: '2026-02-01T10:05:00.000Z'
        })
      ]),
      aircraftList: vi.fn().mockResolvedValue([]),
      logbookListFlightScores: vi.fn().mockResolvedValue([])
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)

    const row = (await screen.findByText('FREE1')).closest('tr')!
    expect(within(row).getByText('G-TEST')).toBeInTheDocument()

    await userEvent.click(row)
    expect(await screen.findByText('G-TEST')).toBeInTheDocument()
  })

  it('does not badge a CSV-imported flight (no OFP, but also never actually flown live) as a free flight', async () => {
    setWinglog({
      logbookListCompletedFlights: vi
        .fn()
        .mockResolvedValue([
          makeFlight({ id: 1, flightNumber: 'IMPORTED', ofpJson: null, actualOffUtc: null })
        ]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([])
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)

    const row = (await screen.findByText('IMPORTED')).closest('tr')!
    expect(within(row).queryByText('Free flight')).not.toBeInTheDocument()
  })

  it('renders a ZZZZ dep/arr as Unknown, never the raw placeholder code', async () => {
    setWinglog({
      logbookListCompletedFlights: vi
        .fn()
        .mockResolvedValue([makeFlight({ id: 1, flightNumber: 'UNKN', depIcao: 'VHHH', arrIcao: 'ZZZZ' })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([])
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)

    expect(await screen.findByText('VHHH → Unknown')).toBeInTheDocument()
    expect(screen.queryByText(/ZZZZ/)).not.toBeInTheDocument()
  })

  it('offers a Flights | Landings tab switcher, and the Landings tab shows logbookListAllLandings data', async () => {
    const user = userEvent.setup()
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ id: 1 })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([]),
      logbookListAllLandings: vi
        .fn()
        .mockResolvedValue([makeLandingListRow({ id: 1, flightId: 1, flightNumber: 'TA100' })])
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await screen.findByText('TA100')

    await user.click(screen.getByRole('tab', { name: 'Landings' }))
    // "Touchdown rate" is a column unique to the Landings sub-tab's own table (the flights
    // table has no such column) — its appearance proves logbookListAllLandings' data made
    // it onto the page, not just that "TA100" happens to also be the flight number.
    expect(await screen.findByRole('columnheader', { name: /Touchdown rate/ })).toBeInTheDocument()
  })

  it('sits the folder tabs between the totals and the table, and keeps arrow-key navigation', async () => {
    const user = userEvent.setup()
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ id: 1 })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([]),
      logbookListAllLandings: vi.fn().mockResolvedValue([makeLandingListRow({ id: 1, flightId: 1 })])
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await screen.findByText('TA100')

    const totals = screen.getByText('Total flights')
    const flightsTab = screen.getByRole('tab', { name: 'Flights' })
    const table = screen.getByRole('table')
    expect(totals.compareDocumentPosition(flightsTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(flightsTab.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Radix's roving focus survives the restyle: arrow right moves to and activates Landings.
    flightsTab.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Landings' })).toHaveAttribute('data-state', 'active')
    expect(await screen.findByRole('columnheader', { name: /Touchdown rate/ })).toBeInTheDocument()
    expect(screen.getByText('Total flights')).toBeInTheDocument()
  })

  it('fetches landings up front so switching to the Landings tab is instant — no skeleton, no second fetch', async () => {
    const user = userEvent.setup()
    const logbookListAllLandings = vi
      .fn()
      .mockResolvedValue([makeLandingListRow({ id: 1, flightId: 1, flightNumber: 'TA100' })])
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ id: 1 })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([]),
      logbookListAllLandings
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await screen.findByText('TA100')
    expect(logbookListAllLandings).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('tab', { name: 'Landings' }))

    // Synchronous getBy*, not findBy*: the Landings rows and headers are there on the very
    // first render after the click, with no loading state in between.
    expect(screen.getByRole('columnheader', { name: /Touchdown rate/ })).toBeInTheDocument()
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull()
    expect(logbookListAllLandings).toHaveBeenCalledTimes(1)
  })

  it("opens a flight's detail when a row is clicked from the Landings sub-tab", async () => {
    const user = userEvent.setup()
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ id: 1 })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookListFlightScores: vi.fn().mockResolvedValue([]),
      logbookListAllLandings: vi
        .fn()
        .mockResolvedValue([makeLandingListRow({ id: 1, flightId: 1, flightNumber: 'TA100' })])
    })
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await screen.findByText('TA100')

    await user.click(screen.getByRole('tab', { name: 'Landings' }))
    const row = (await screen.findByRole('columnheader', { name: /Touchdown rate/ })).closest('table')!
    await user.click(within(row).getByText('TA100'))

    expect(await screen.findByText('TA100 — EGLL → EGKK')).toBeInTheDocument()
  })
})

describe('LandingCard', () => {
  it('renders the fetched score and severity', async () => {
    setWinglog({
      logbookListLandings: vi.fn().mockResolvedValue([
        makeLandingWithDetails({
          score: { score: 78, severity: 'firm', categories: makeCategories() } satisfies LandingScoreResult
        })
      ])
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    expect(await screen.findByText('78')).toBeInTheDocument()
    expect(screen.getByText('Firm')).toBeInTheDocument()
  })

  it('lets long labels and values shrink and wrap instead of overlapping when the card narrows', async () => {
    setWinglog({
      logbookListLandings: vi.fn().mockResolvedValue([
        makeLandingWithDetails({
          score: { score: 78, severity: 'firm', categories: makeCategories() } satisfies LandingScoreResult
        })
      ])
    })
    const { container } = render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    const label = await screen.findByText('Airspeed / Ground speed')
    expect(label).toHaveClass('min-w-0', 'break-words')
    expect(label.nextElementSibling).toHaveClass('min-w-0', 'break-words')
    // Shrinkable grid tracks (a bare `1fr` can't go below its content's width) and a
    // container query, since the card's width depends on the layout around it.
    expect(container.querySelector('dl')).toHaveClass('grid-cols-[minmax(0,1fr)_minmax(0,1fr)]')
    expect(container.querySelector('[data-slot="card"]')).toHaveClass('@container')
  })

  it('renders nothing extra when the flight has no landing row', async () => {
    setWinglog({
      logbookListLandings: vi.fn().mockResolvedValue([])
    })
    const { container } = render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('shows a dash for the score while none/hard badge is absent for a "none" severity landing', async () => {
    setWinglog({
      logbookListLandings: vi.fn().mockResolvedValue([makeLandingWithDetails()])
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    await screen.findByText('Touchdown rate')
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('Firm')).not.toBeInTheDocument()
    expect(screen.queryByText('Hard')).not.toBeInTheDocument()
  })

  it('shows a warning icon next to a field whose own category scored badly, not next to a good one', async () => {
    setWinglog({
      logbookListLandings: vi.fn().mockResolvedValue([
        makeLandingWithDetails({
          score: {
            score: 55,
            severity: 'none',
            categories: makeCategories({ crab: 10, pitch: 95 })
          } satisfies LandingScoreResult
        })
      ])
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
      logbookListLandings: vi.fn().mockResolvedValue([
        makeLandingWithDetails({
          score: {
            score: 55,
            severity: 'none',
            categories: makeCategories({ crab: 10 })
          } satisfies LandingScoreResult
        })
      ])
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    const trigger = await screen.findByRole('button', { name: 'Score breakdown' })
    expect(screen.queryByText(/Landing score breakdown —/)).not.toBeInTheDocument()

    await user.click(trigger)
    expect(screen.getByText('Landing score breakdown — 55/100')).toBeInTheDocument()
  })

  it('defaults to the final touchdown when a flight has more than one', async () => {
    setWinglog({
      logbookListLandings: vi
        .fn()
        .mockResolvedValue([
          makeLandingWithDetails({ seq: 1, verticalSpeedMs: -1.5 }),
          makeLandingWithDetails({ seq: 2, verticalSpeedMs: -3.2 })
        ])
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    // -3.2 m/s -> ~630 fpm, -1.5 m/s -> ~295 fpm — asserting the final landing's own
    // figure is shown, not the first one's.
    expect(await screen.findByText(/630 fpm/)).toBeInTheDocument()
  })

  it('shows no switcher at all for a flight with only one landing', async () => {
    setWinglog({
      logbookListLandings: vi.fn().mockResolvedValue([makeLandingWithDetails({ id: 1, seq: 1 })])
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    await screen.findByText('Touchdown rate')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('offers tabs (not a select) for up to 4 landings, labelled by airfield and attempt, and switches the shown figures on click', async () => {
    const user = userEvent.setup()
    setWinglog({
      logbookListLandings: vi.fn().mockResolvedValue([
        // Callum's real loop: touch-and-go at Kai Tak, then two at Hong Kong International.
        makeLandingWithDetails({ id: 1, seq: 1, icao: 'VHHX', runwayIdent: null, verticalSpeedMs: -0.5 }),
        makeLandingWithDetails({ id: 2, seq: 2, icao: 'VHHH', runwayIdent: '25L', verticalSpeedMs: -1.5 }),
        makeLandingWithDetails({ id: 3, seq: 3, icao: 'VHHH', runwayIdent: '25L', verticalSpeedMs: -3.5 })
      ])
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    expect(await screen.findByRole('tablist')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['VHHX 1', 'VHHH 1', 'VHHH 2'])
    // Defaults to the final landing: -3.5 m/s -> ~689 fpm.
    expect(await screen.findByText(/689 fpm/)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'VHHX 1' }))
    // -0.5 m/s -> ~98 fpm, the first landing's own figure.
    expect(await screen.findByText(/98 fpm/)).toBeInTheDocument()
  })

  it('offers a select instead of tabs beyond the tab threshold', async () => {
    setWinglog({
      logbookListLandings: vi
        .fn()
        .mockResolvedValue([
          makeLandingWithDetails({ id: 1, seq: 1, runwayIdent: '01' }),
          makeLandingWithDetails({ id: 2, seq: 2, runwayIdent: '02' }),
          makeLandingWithDetails({ id: 3, seq: 3, runwayIdent: '03' }),
          makeLandingWithDetails({ id: 4, seq: 4, runwayIdent: '04' }),
          makeLandingWithDetails({ id: 5, seq: 5, runwayIdent: '05' })
        ])
    })
    render(<LandingCard flightId={1} landingDistanceUnit="ft" />)

    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })
})

describe('landingLabels', () => {
  it('numbers attempts per airfield, in touchdown order', () => {
    expect(landingLabels([{ icao: 'VHHX' }, { icao: 'VHHH' }, { icao: 'VHHH' }])).toEqual([
      'VHHX 1',
      'VHHH 1',
      'VHHH 2'
    ])
    // A return to an earlier field continues that field's own count.
    expect(landingLabels([{ icao: 'EGLL' }, { icao: 'EGCC' }, { icao: 'EGLL' }])).toEqual([
      'EGLL 1',
      'EGCC 1',
      'EGLL 2'
    ])
  })

  it('falls back to the position in the sequence when no airfield resolved, and never shows the ZZZZ placeholder', () => {
    expect(landingLabels([{ icao: null }, { icao: 'VHHH' }, { icao: null }])).toEqual([
      'Landing 1',
      'VHHH 1',
      'Landing 3'
    ])
    expect(landingLabels([{ icao: 'ZZZZ' }])).toEqual(['Unknown 1'])
  })
})

describe('LandingsTable', () => {
  it('renders one row per landing, across different flights and aircraft', async () => {
    setWinglog({
      logbookListAllLandings: vi
        .fn()
        .mockResolvedValue([
          makeLandingListRow({ id: 1, flightId: 1, aircraftRegistration: 'G-ONE', flightNumber: 'TA100' }),
          makeLandingListRow({ id: 2, flightId: 2, aircraftRegistration: 'G-TWO', flightNumber: 'TA200' })
        ])
    })
    render(<LandingsTable onOpenFlight={vi.fn()} />)

    expect(await screen.findByText('G-ONE')).toBeInTheDocument()
    expect(screen.getByText('G-TWO')).toBeInTheDocument()
    expect(screen.getByText('TA100')).toBeInTheDocument()
    expect(screen.getByText('TA200')).toBeInTheDocument()
  })

  it("renders a landing's ZZZZ icao as Unknown, never the raw placeholder", async () => {
    setWinglog({
      logbookListAllLandings: vi
        .fn()
        .mockResolvedValue([makeLandingListRow({ id: 1, flightId: 1, icao: 'ZZZZ' })])
    })
    render(<LandingsTable onOpenFlight={vi.fn()} />)

    expect(await screen.findByText(/^Unknown/)).toBeInTheDocument()
    expect(screen.queryByText(/ZZZZ/)).not.toBeInTheDocument()
  })

  it('lines its columns up with the Flights table so switching tabs does not shuffle the headers', async () => {
    setWinglog({
      logbookListAllLandings: vi.fn().mockResolvedValue([makeLandingListRow({ id: 1, flightId: 1 })])
    })
    render(<LandingsTable onOpenFlight={vi.fn()} />)
    await screen.findByText('TA100')
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    // Flights: Date, Flight, Route, Aircraft, ... Landing Score
    expect(headers.slice(0, 4)).toEqual(['Date', 'Flight', 'Airport / Runway', 'Aircraft'])
  })

  it('renders from prefetched rows without fetching or showing a skeleton', () => {
    const logbookListAllLandings = vi.fn()
    setWinglog({ logbookListAllLandings })
    render(<LandingsTable onOpenFlight={vi.fn()} landings={[makeLandingListRow({ id: 1, flightId: 1 })]} />)
    expect(screen.getByText('TA100')).toBeInTheDocument()
    expect(logbookListAllLandings).not.toHaveBeenCalled()
  })

  it('shows a placeholder message when nothing has landed yet', async () => {
    setWinglog({ logbookListAllLandings: vi.fn().mockResolvedValue([]) })
    render(<LandingsTable onOpenFlight={vi.fn()} />)

    expect(await screen.findByText('No landings recorded yet.')).toBeInTheDocument()
  })

  it("calls onOpenFlight with the row's own flightId when clicked", async () => {
    const user = userEvent.setup()
    const onOpenFlight = vi.fn()
    setWinglog({
      logbookListAllLandings: vi.fn().mockResolvedValue([makeLandingListRow({ id: 1, flightId: 42 })])
    })
    render(<LandingsTable onOpenFlight={onOpenFlight} />)

    const row = (await screen.findByText('TA100')).closest('tr')!
    await user.click(row)
    expect(onOpenFlight).toHaveBeenCalledWith(42)
  })

  it('sorts by touchdown rate, worst first, on header click', async () => {
    const user = userEvent.setup()
    setWinglog({
      logbookListAllLandings: vi
        .fn()
        .mockResolvedValue([
          makeLandingListRow({ id: 1, flightId: 1, flightNumber: 'SOFT', verticalSpeedMs: -0.5 }),
          makeLandingListRow({ id: 2, flightId: 2, flightNumber: 'FIRM', verticalSpeedMs: -3.5 })
        ])
    })
    render(<LandingsTable onOpenFlight={vi.fn()} />)
    await screen.findByText('SOFT')

    await user.click(screen.getByRole('columnheader', { name: /Touchdown rate/ }))
    const rowsAsc = screen.getAllByRole('row').slice(1)
    expect(within(rowsAsc[0]).getByText('FIRM')).toBeInTheDocument()

    await user.click(screen.getByRole('columnheader', { name: /Touchdown rate/ }))
    const rowsDesc = screen.getAllByRole('row').slice(1)
    expect(within(rowsDesc[0]).getByText('SOFT')).toBeInTheDocument()
  })

  it('sorts by score, treating a missing score the same as zero', async () => {
    const user = userEvent.setup()
    setWinglog({
      logbookListAllLandings: vi
        .fn()
        .mockResolvedValue([
          makeLandingListRow({ id: 1, flightId: 1, flightNumber: 'HIGH', score: 90, severity: 'none' }),
          makeLandingListRow({ id: 2, flightId: 2, flightNumber: 'NONE', score: null, severity: null })
        ])
    })
    render(<LandingsTable onOpenFlight={vi.fn()} />)
    await screen.findByText('HIGH')

    await user.click(screen.getByRole('columnheader', { name: 'Score' }))
    const rowsAsc = screen.getAllByRole('row').slice(1)
    expect(within(rowsAsc[0]).getByText('NONE')).toBeInTheDocument()
  })

  it('sorts by aircraft, airport/runway, and flight number', async () => {
    const user = userEvent.setup()
    setWinglog({
      logbookListAllLandings: vi.fn().mockResolvedValue([
        makeLandingListRow({
          id: 1,
          flightId: 1,
          flightNumber: 'ZULU',
          aircraftRegistration: 'G-ZULU',
          icao: 'ZZZZ',
          runwayIdent: '09'
        }),
        makeLandingListRow({
          id: 2,
          flightId: 2,
          flightNumber: 'ALPHA',
          aircraftRegistration: 'G-ALPHA',
          icao: 'AAAA',
          runwayIdent: '27'
        })
      ])
    })
    render(<LandingsTable onOpenFlight={vi.fn()} />)
    await screen.findByText('ZULU')

    // Each click sets that column as the new sort key ascending (useSortable's own
    // behaviour) — 'G-ALPHA'/'AAAA'/'ALPHA' all sort before their 'Z...' counterparts.
    await user.click(screen.getByRole('columnheader', { name: 'Aircraft' }))
    expect(within(screen.getAllByRole('row')[1]).getByText('ALPHA')).toBeInTheDocument()

    await user.click(screen.getByRole('columnheader', { name: 'Airport / Runway' }))
    expect(within(screen.getAllByRole('row')[1]).getByText('ALPHA')).toBeInTheDocument()

    await user.click(screen.getByRole('columnheader', { name: 'Flight' }))
    expect(within(screen.getAllByRole('row')[1]).getByText('ALPHA')).toBeInTheDocument()
  })
})

describe('FlightDetail', () => {
  it('opens a flight from the list and shows its summary', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight()]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))

    expect(await screen.findByText('TA100 — EGLL → EGKK')).toBeInTheDocument()
    expect(screen.getByText('G-ONE')).toBeInTheDocument()
    expect(screen.getByText('2h 0m')).toBeInTheDocument() // block minutes: 120
    expect(screen.getByText('1h 40m')).toBeInTheDocument() // air minutes: 100
  })

  it('shows Unknown for a ZZZZ arrival and a Free flight badge on the detail header', async () => {
    setWinglog({
      logbookListCompletedFlights: vi
        .fn()
        .mockResolvedValue([
          makeFlight({ arrIcao: 'ZZZZ', ofpJson: null, actualOffUtc: '2026-02-01T10:05:00.000Z' })
        ]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))

    expect(await screen.findByText('TA100 — EGLL → Unknown')).toBeInTheDocument()
    expect(screen.getByText('Free flight')).toBeInTheDocument()
  })

  describe('"Add to fleet" (free-flight-tracking.md follow-up)', () => {
    function freeFlightNoAircraft(overrides: Partial<Flight> = {}): Flight {
      return makeFlight({
        aircraftId: null,
        simRegistration: 'G-TEST',
        simIcaoType: 'C172',
        ofpJson: null,
        actualOffUtc: '2026-02-01T10:05:00.000Z',
        ...overrides
      })
    }

    it('shows "Add to fleet" only for a free flight with no linked aircraft', async () => {
      setWinglog({
        logbookListCompletedFlights: vi.fn().mockResolvedValue([freeFlightNoAircraft()]),
        aircraftList: vi.fn().mockResolvedValue([])
      })
      const user = userEvent.setup()
      render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
      await user.click(await screen.findByText('TA100'))

      expect(await screen.findByRole('button', { name: 'Add to fleet' })).toBeInTheDocument()
    })

    it('hides "Add to fleet" for an ordinary dispatched flight with a linked aircraft', async () => {
      setWinglog({
        logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight()]),
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
      })
      const user = userEvent.setup()
      render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
      await user.click(await screen.findByText('TA100'))
      await screen.findByText('TA100 — EGLL → EGKK')

      expect(screen.queryByRole('button', { name: 'Add to fleet' })).not.toBeInTheDocument()
    })

    it('creates a new fleet aircraft from the sim-reported identity and links it, then reloads', async () => {
      const aircraftCreate = vi
        .fn()
        .mockResolvedValue(makeAircraft({ id: 42, registration: 'G-TEST', icaoType: 'C172' }))
      const flightLinkAircraft = vi
        .fn()
        .mockResolvedValue(freeFlightNoAircraft({ aircraftId: 42, simRegistration: null, simIcaoType: null }))
      const aircraftList = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([makeAircraft({ id: 42, registration: 'G-TEST', icaoType: 'C172' })])
      setWinglog({
        logbookListCompletedFlights: vi.fn().mockResolvedValue([freeFlightNoAircraft()]),
        aircraftList,
        aircraftTypeSearch: vi.fn().mockResolvedValue([]),
        aircraftCreate,
        flightLinkAircraft
      })
      const user = userEvent.setup()
      render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
      await user.click(await screen.findByText('TA100'))
      await user.click(await screen.findByRole('button', { name: 'Add to fleet' }))

      expect(await screen.findByLabelText('Registration')).toHaveValue('G-TEST')
      // Two buttons now say "Add to fleet" — the trigger (still in the page behind the
      // dialog) and the dialog's own submit button, which is always the later one in
      // document order.
      const buttons = screen.getAllByRole('button', { name: 'Add to fleet' })
      await user.click(buttons[buttons.length - 1])

      await waitFor(() =>
        expect(aircraftCreate).toHaveBeenCalledWith({ registration: 'G-TEST', icaoType: 'C172' })
      )
      await waitFor(() => expect(flightLinkAircraft).toHaveBeenCalledWith(1, 42))
      await waitFor(() => expect(aircraftList).toHaveBeenCalledTimes(2))
    })
  })

  it('returns to the list via "Back to logbook"', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight()]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    await screen.findByText('TA100 — EGLL → EGKK')

    await user.click(screen.getByRole('button', { name: 'Back to logbook' }))
    expect(await screen.findByText('Logbook', { selector: 'h1' })).toBeInTheDocument()
    expect(screen.getByText('TA100')).toBeInTheDocument()
  })

  it('opens directly via initialFlightId with a "Back to aircraft" button that calls back', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ id: 3 })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const onBackToAircraft = vi.fn()
    render(
      <LogbookView
        weightUnit="kg"
        landingDistanceUnit="ft"
        initialFlightId={3}
        initialFlightOriginAircraftId={7}
        onBackToAircraft={onBackToAircraft}
      />
    )
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Back to aircraft' }))
    expect(onBackToAircraft).toHaveBeenCalledWith(7)
  })

  it('deletes a flight after confirming, and returns to the list', async () => {
    const winglog = setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValueOnce([makeFlight()]).mockResolvedValue([]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      trackPointList: vi.fn().mockResolvedValue([makeTrackPoint()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    await screen.findByText('TA100 — EGLL → EGKK')

    await user.click(screen.getByRole('button', { name: 'Delete flight' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/1 point/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete flight' }))

    expect(winglog.flightDelete).toHaveBeenCalledWith(1)
    expect(
      await screen.findByText(
        'No completed flights yet — track one, or import a CSV logbook from Settings → Data.'
      )
    ).toBeInTheDocument()
  })

  it('leaves the flight alone when the delete confirmation is cancelled', async () => {
    const winglog = setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight()]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    await screen.findByText('TA100 — EGLL → EGKK')

    await user.click(screen.getByRole('button', { name: 'Delete flight' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Back' }))

    expect(winglog.flightDelete).not.toHaveBeenCalled()
    expect(screen.getByText('TA100 — EGLL → EGKK')).toBeInTheDocument()
  })

  it('shows an error toast with the stringified value when delete fails with a non-Error', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight()]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      flightDelete: vi.fn().mockRejectedValue('boom')
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    await screen.findByText('TA100 — EGLL → EGKK')

    await user.click(screen.getByRole('button', { name: 'Delete flight' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete flight' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'))
    // The delete failed, so the detail page is still showing this flight.
    expect(screen.getByText('TA100 — EGLL → EGKK')).toBeInTheDocument()
  })

  it('uses the real OFP-derived route and waypoints when the flight has one, skipping the great-circle fallback', async () => {
    const ofpJson = JSON.stringify({
      navlog: {
        fix: [
          { ident: 'EGLL', pos_lat: 51.4775, pos_long: -0.4614, altitude_feet: 0 },
          { ident: 'MID', pos_lat: 51.3, pos_long: -0.3, altitude_feet: 5000 },
          { ident: 'EGKK', pos_lat: 51.1481, pos_long: -0.1903, altitude_feet: 0 }
        ]
      }
    })
    const winglog = setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ ofpJson })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    await screen.findByText('TA100 — EGLL → EGKK')

    expect(winglog.logbookGreatCircleRoute).not.toHaveBeenCalled()
    expect(
      screen.queryByText('Approximate route — no flight plan on file for this flight')
    ).not.toBeInTheDocument()
  })

  it('sorts the list by every column when its header is clicked', async () => {
    const flightA = makeFlight({
      id: 1,
      flightNumber: 'BBB',
      depIcao: 'EGLL',
      arrIcao: 'EGKK',
      actualOutUtc: '2026-02-02T10:00:00.000Z',
      blockMinutes: 60,
      fuelBurnKg: 1000
    })
    const flightB = makeFlight({
      id: 2,
      flightNumber: 'AAA',
      depIcao: 'EGCC',
      arrIcao: 'EGPH',
      actualOutUtc: '2026-02-01T10:00:00.000Z',
      blockMinutes: 90,
      fuelBurnKg: 2000,
      aircraftId: 2
    })
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([flightA, flightB]),
      aircraftList: vi
        .fn()
        .mockResolvedValue([
          makeAircraft({ id: 1, registration: 'G-BBB' }),
          makeAircraft({ id: 2, registration: 'G-AAA' })
        ])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await screen.findByText('BBB')

    function firstRowFlightNumber(): string {
      return within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1].textContent ?? ''
    }

    await user.click(screen.getByRole('columnheader', { name: 'Date' }))
    expect(firstRowFlightNumber()).toBe('AAA')
    await user.click(screen.getByRole('columnheader', { name: 'Flight' }))
    expect(firstRowFlightNumber()).toBe('AAA')
    await user.click(screen.getByRole('columnheader', { name: 'Route' }))
    expect(firstRowFlightNumber()).toBe('AAA') // EGCC.. sorts before EGLL..
    await user.click(screen.getByRole('columnheader', { name: 'Aircraft' }))
    expect(firstRowFlightNumber()).toBe('AAA') // G-AAA sorts before G-BBB
    await user.click(screen.getByRole('columnheader', { name: 'Block' }))
    expect(firstRowFlightNumber()).toBe('BBB') // 60 < 90
    await user.click(screen.getByRole('columnheader', { name: 'Fuel burn' }))
    expect(firstRowFlightNumber()).toBe('BBB') // 1000 < 2000
  })

  it('shows "View OFP PDF" only for a flight with an OFP, and opens it', async () => {
    const winglog = setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ ofpJson: '{}' })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))

    await user.click(await screen.findByRole('button', { name: 'View OFP PDF' }))
    expect(winglog.logbookOpenOfpPdf).toHaveBeenCalledWith(1)
  })

  it('does not show "View OFP PDF" for a flight with no OFP', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ ofpJson: null })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    await screen.findByText('TA100 — EGLL → EGKK')
    expect(screen.queryByRole('button', { name: 'View OFP PDF' })).not.toBeInTheDocument()
  })

  it('shows an error toast when the OFP has no PDF to open', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ ofpJson: '{}' })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookOpenOfpPdf: vi.fn().mockResolvedValue(false)
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    await user.click(await screen.findByRole('button', { name: 'View OFP PDF' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No OFP PDF available for this flight.'))
  })

  it('renders altitude/speed charts once there are at least two track points, with an IAS/Mach toggle', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight()]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      trackPointList: vi
        .fn()
        .mockResolvedValue([
          makeTrackPoint({ id: 1, tsUtc: '2026-02-01T10:00:00.000Z' }),
          makeTrackPoint({ id: 2, tsUtc: '2026-02-01T10:05:00.000Z' })
        ])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))

    expect(await screen.findByText('Speed (IAS)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mach' }))
    expect(await screen.findByText('Speed (Mach)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'IAS' }))
    expect(await screen.findByText('Speed (IAS)')).toBeInTheDocument()
  })

  it('does not render the altitude/speed charts for a flight with fewer than two track points', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight()]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      trackPointList: vi.fn().mockResolvedValue([makeTrackPoint()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    await screen.findByText('TA100 — EGLL → EGKK')
    expect(screen.queryByText(/Speed \(/)).not.toBeInTheDocument()
  })

  it('labels the altitude chart "True altitude" when no track point has a recorded pressure altitude', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight()]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      trackPointList: vi
        .fn()
        .mockResolvedValue([
          makeTrackPoint({ id: 1, tsUtc: '2026-02-01T10:00:00.000Z', pressureAltitudeM: null }),
          makeTrackPoint({ id: 2, tsUtc: '2026-02-01T10:05:00.000Z', pressureAltitudeM: null })
        ])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    expect(await screen.findByText('True altitude')).toBeInTheDocument()
  })

  it('labels the altitude chart plainly "Altitude" once pressure altitude was recorded', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight()]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      trackPointList: vi
        .fn()
        .mockResolvedValue([
          makeTrackPoint({ id: 1, tsUtc: '2026-02-01T10:00:00.000Z', pressureAltitudeM: 950 }),
          makeTrackPoint({ id: 2, tsUtc: '2026-02-01T10:05:00.000Z', pressureAltitudeM: 960 })
        ])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    expect(await screen.findByText('Altitude')).toBeInTheDocument()
    expect(screen.queryByText('True altitude')).not.toBeInTheDocument()
  })

  it('shows the fuel planned-vs-actual chart only when the flight has a planned fuel figure', async () => {
    setWinglog({
      logbookListCompletedFlights: vi
        .fn()
        .mockResolvedValue([makeFlight({ fuelPlannedKg: 5000, fuelBurnKg: 4200 })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    expect(await screen.findByText('Fuel planned vs actual')).toBeInTheDocument()
  })

  it('does not show the fuel chart for an ad hoc flight with no planned fuel figure', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ fuelPlannedKg: null })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    await screen.findByText('TA100 — EGLL → EGKK')
    expect(screen.queryByText('Fuel planned vs actual')).not.toBeInTheDocument()
  })

  it('falls back to a great-circle route and shows the approximate-route caption for a flight with no OFP', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight({ ofpJson: null })]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookGreatCircleRoute: vi.fn().mockResolvedValue([
        [-0.4614, 51.4775],
        [-0.1903, 51.1481]
      ])
    })
    const user = userEvent.setup()
    render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" />)
    await user.click(await screen.findByText('TA100'))
    expect(
      await screen.findByText('Approximate route — no flight plan on file for this flight')
    ).toBeInTheDocument()
  })

  it('resetSignal returns to the list without disturbing sort, but not on the initial mount', async () => {
    setWinglog({
      logbookListCompletedFlights: vi.fn().mockResolvedValue([makeFlight()]),
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()])
    })
    const user = userEvent.setup()
    const { rerender } = render(<LogbookView weightUnit="kg" landingDistanceUnit="ft" resetSignal={1} />)
    await user.click(await screen.findByText('TA100'))
    await screen.findByText('TA100 — EGLL → EGKK')

    rerender(<LogbookView weightUnit="kg" landingDistanceUnit="ft" resetSignal={2} />)
    expect(await screen.findByText('TA100')).toBeInTheDocument()
  })
})
