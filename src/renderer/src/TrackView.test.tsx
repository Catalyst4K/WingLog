import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  Aircraft,
  DispatchOfp,
  Flight,
  ProcedureSelection,
  SimTelemetry,
  TrackPoint,
  WingLogApi
} from '@shared/ipc'
import { emptyProcedureSelection } from './procedureSelection'
import { TrackView } from './TrackView'

// sonner's real toast has nothing to render into in these tests (no <Toaster/> mounted)
// and isn't a spy — mock it so `toast.error`/`toast.success` assertions work, matching the
// one IPC-adjacent seam (window.winglog) this batch's other tests mock.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

afterEach(() => {
  vi.clearAllMocks()
})

// FlightMap (rendered for real by TrackView, per the batch instructions) pulls in
// maplibre-gl, which needs a real WebGL/worker environment MapLibreMap can't get inside
// jsdom (no canvas/WebGL context, no functional Worker loading a blob: URL the way the
// component expects). A light mock of the constructor as a no-op class, plus the handful
// of instance methods FlightMap actually calls, is enough for FlightMap's own effects to
// run to completion without throwing — this is the one exception to "never mock a child
// component," justified because the failure mode isn't application logic, it's jsdom
// lacking a real GPU/worker stack MapLibre needs.
vi.mock('maplibre-gl', () => {
  class FakeEvented {
    on = vi.fn()
  }
  class FakeMap extends FakeEvented {
    remove = vi.fn()
    addSource = vi.fn()
    addLayer = vi.fn()
    getSource = vi.fn(() => ({ setData: vi.fn() }))
    setLayoutProperty = vi.fn()
    fitBounds = vi.fn()
    jumpTo = vi.fn()
    easeTo = vi.fn()
    getCenter = vi.fn(() => ({ toArray: () => [0, 0] }))
    getZoom = vi.fn(() => 1)
    zoomIn = vi.fn()
    zoomOut = vi.fn()
    touchZoomRotate = { disableRotation: vi.fn(), enable: vi.fn() }
    keyboard = { disableRotation: vi.fn(), enable: vi.fn(), disable: vi.fn() }
    dragPan = { enable: vi.fn(), disable: vi.fn() }
    scrollZoom = { enable: vi.fn(), disable: vi.fn() }
    doubleClickZoom = { enable: vi.fn(), disable: vi.fn() }
  }
  class FakeMarker {
    setLngLat = vi.fn().mockReturnThis()
    setRotation = vi.fn().mockReturnThis()
    addTo = vi.fn().mockReturnThis()
    remove = vi.fn().mockReturnThis()
    getElement = vi.fn(() => ({ isConnected: false }))
  }
  class FakeLngLatBounds {
    extend(): FakeLngLatBounds {
      return this
    }
  }
  return {
    Map: FakeMap,
    Marker: FakeMarker,
    LngLatBounds: FakeLngLatBounds,
    GeoJSONSource: class {},
    setWorkerUrl: vi.fn()
  }
})

vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: 'blob:fake-worker' }))

// FlightMap's one-time setup effect awaits ensureWorkerReady() (FlightMap.tsx) before ever
// touching the (now-mocked) MapLibreMap constructor — that helper does a real
// fetch(workerUrl).then(r => r.blob()).then(blob => setWorkerUrl(URL.createObjectURL(blob)))
// with no .catch of its own. Node's undici fetch has no real support for blob:/data: worker
// URLs the way a browser does, so even with maplibre-gl itself mocked, this one real
// network call still rejects and surfaces as an unhandled rejection per FlightMap mount.
// Stubbing fetch/createObjectURL keeps that promise chain resolving instead — setWorkerUrl
// itself is already a no-op on the mocked module above, so the actual value here is never
// used for anything.
vi.stubGlobal(
  'fetch',
  vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob()) } as unknown as Response)
)
if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:mock')
} else {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
}

const AIRCRAFT: Aircraft = {
  id: 1,
  registration: 'G-XWBS',
  icaoType: 'A35K',
  operator: 'British Airways',
  operatorIata: 'BA',
  operatorIcao: 'BAW',
  simbriefAirframeId: null,
  simbriefType: null,
  simbriefAirframeDeveloper: null,
  simbriefAirframeEngines: null,
  simbriefAirframeRegistration: null,
  currentIcao: 'EGLL',
  createdAt: '2026-01-01T00:00:00.000Z',
  replacedByAircraftId: null,
  photoThumbnailUrl: null
}

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 1,
    aircraftId: 1,
    status: 'planned',
    flightNumber: 'BAW31',
    depIcao: 'EGLL',
    arrIcao: 'VHHH',
    altnIcao: null,
    routeString: null,
    cruiseAltM: null,
    schedOutUtc: null,
    schedInUtc: null,
    actualOutUtc: null,
    actualOffUtc: null,
    actualOnUtc: null,
    actualInUtc: null,
    blockMinutes: null,
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
    ...overrides
  }
}

function makeDispatchOfp(overrides: Partial<DispatchOfp> = {}): DispatchOfp {
  return {
    ofpId: 'ofp-1',
    aircraftIcaoType: 'A35K',
    aircraftRegistration: 'G-XWBS',
    flightNumber: 'BAW31',
    depIcao: 'EGLL',
    arrIcao: 'VHHH',
    altnIcao: 'EGKK',
    routeString: 'DCT',
    cruiseAltM: 11000,
    schedOutUtc: '2026-01-01T10:00:00.000Z',
    schedInUtc: '2026-01-01T22:00:00.000Z',
    fuelPlannedKg: 90000,
    pax: 200,
    cargoKg: 5000,
    zfwKg: 200000,
    towKg: 250000,
    ldwKg: 210000,
    costIndex: 20,
    waypoints: [],
    stepClimbs: [],
    ofpJson: '{}',
    matchedAircraftId: null,
    simbriefIsCustom: false,
    simbriefInternalId: null,
    ...overrides
  }
}

function makeTrackPoint(overrides: Partial<TrackPoint> = {}): TrackPoint {
  return {
    id: 1,
    flightId: 1,
    tsUtc: '2026-01-01T00:00:00.000Z',
    latitude: 51.47,
    longitude: -0.45,
    altitudeM: 1000,
    altitudeAglM: 900,
    indicatedAirspeedMs: 100,
    machSpeed: 0.3,
    groundSpeedMs: 100,
    verticalSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 2,
    bankDeg: 0,
    phase: 'climb',
    onGround: false,
    fuelKg: 50000,
    gForce: 1,
    windSpeedMs: 5,
    windDirectionDeg: 250,
    resumeSegment: 0,
    simRate: 1,
    excludedReason: null,
    ...overrides
  }
}

function buildWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  return {
    aircraftList: vi.fn().mockResolvedValue([]),
    flightList: vi.fn().mockResolvedValue([]),
    trackingGetActive: vi.fn().mockResolvedValue(null),
    trackPointList: vi.fn().mockResolvedValue([]),
    onTrackingPoint: vi.fn(() => () => {}),
    trackingStart: vi.fn().mockResolvedValue(undefined),
    trackingStop: vi.fn().mockResolvedValue(undefined),
    trackingFinish: vi.fn().mockResolvedValue(undefined),
    flightCancel: vi.fn().mockResolvedValue(undefined),
    trackingSetProcedureSelection: vi.fn().mockResolvedValue(undefined),
    navdataRefreshAirport: vi.fn().mockResolvedValue(undefined),
    navdataListRunways: vi.fn().mockResolvedValue([]),
    navdataListSids: vi.fn().mockResolvedValue([]),
    navdataListStars: vi.fn().mockResolvedValue([]),
    navdataListApproaches: vi.fn().mockResolvedValue([]),
    navdataGetProcedureWaypoints: vi.fn().mockResolvedValue([]),
    ...overrides
  } as WingLogApi
}

function setWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = buildWinglog(overrides)
  window.winglog = api
  return api
}

function renderTrack(
  props: Partial<Parameters<typeof TrackView>[0]> = {}
): ReturnType<typeof render> {
  const selection = props.selection ?? emptyProcedureSelection()
  const onSelectionChange = props.onSelectionChange ?? vi.fn()
  return render(<TrackView {...props} selection={selection} onSelectionChange={onSelectionChange} />)
}

describe('TrackView', () => {
  it('shows the empty state when there is nothing planned or active', async () => {
    setWinglog()
    renderTrack()
    expect(await screen.findByText('No planned flights to track — dispatch one first.')).toBeInTheDocument()
    // Nothing planned/active/preview — no Procedures affordance either.
    expect(screen.queryByText('Procedures…')).not.toBeInTheDocument()
  })

  it('lists planned flights with a Start tracking button each, and shows the Procedures affordance', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()])
    })
    renderTrack()
    expect(await screen.findByText('BAW31')).toBeInTheDocument()
    expect(screen.getByText('A35K · G-XWBS')).toBeInTheDocument()
    expect(screen.getByText('Start tracking')).toBeInTheDocument()
    expect(screen.getByText('Procedures…')).toBeInTheDocument()
    expect(screen.getByText('Nothing selected yet')).toBeInTheDocument()
  })

  it('shows the joined selection summary instead of "Nothing selected yet" once something is chosen', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()])
    })
    const selection: ProcedureSelection = { ...emptyProcedureSelection(), sidIdent: 'DET2G', starIdent: 'ABC1' }
    renderTrack({ selection })
    await screen.findByText('Start tracking')
    expect(screen.getByText('DET2G · ABC1')).toBeInTheDocument()
  })

  it('opens the Procedures dialog showing the live procedure selectors', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()])
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Start tracking')
    await user.click(screen.getByText('Procedures…'))
    expect(await screen.findByText('Departure runway')).toBeInTheDocument()
    expect(screen.getByText('SID')).toBeInTheDocument()
    expect(screen.getByText('STAR')).toBeInTheDocument()
  })

  it('falls back to dep → arr when a planned flight has no flight number', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ flightNumber: null, aircraftId: 99 })])
    })
    renderTrack()
    expect(await screen.findByText('EGLL → VHHH')).toBeInTheDocument()
  })

  it('starts tracking a planned flight', async () => {
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()]),
      // Nothing active yet on the initial mount fetch — only becomes active once
      // handleStart re-fetches it after trackingStart resolves.
      trackingGetActive: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ flightId: 1, phase: 'taxi' })
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Start tracking')
    await user.click(screen.getByText('Start tracking'))
    expect(winglog.trackingStart).toHaveBeenCalledWith(1)
    expect(await screen.findByText('Phase:')).toBeInTheDocument()
  })

  it('shows a toast when starting tracking fails', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()]),
      trackingStart: vi.fn().mockRejectedValue(new Error('no sim connection'))
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Start tracking')
    await user.click(screen.getByText('Start tracking'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('no sim connection'))
  })

  it('shows a stringified toast when starting tracking fails with a non-Error', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()]),
      trackingStart: vi.fn().mockRejectedValue('nope')
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Start tracking')
    await user.click(screen.getByText('Start tracking'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'))
  })

  it('shows the active flight banner with its phase, and no planned-flight list', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'cruise' })
    })
    renderTrack()
    expect(await screen.findByText('cruise')).toBeInTheDocument()
    expect(screen.getByText('Cancel flight')).toBeInTheDocument()
    expect(screen.getByText('Finish & save')).toBeInTheDocument()
  })

  it('falls back to a bare flight-id label when the active flight is not in the flight list', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([]),
      flightList: vi.fn().mockResolvedValue([]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 42, phase: 'taxi' })
    })
    renderTrack()
    expect(await screen.findByText('flight #42')).toBeInTheDocument()
  })

  it('cancelling the active flight confirms, then stops tracking and notifies onFlightEnded', async () => {
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'cruise' })
    })
    const onFlightEnded = vi.fn()
    const user = userEvent.setup()
    renderTrack({ onFlightEnded })
    await screen.findByText('Cancel flight')
    await user.click(screen.getByText('Cancel flight'))
    expect(await screen.findByText('Cancel BAW31?')).toBeInTheDocument()
    await user.click(screen.getByText('Back'))
    expect(screen.queryByText('Cancel BAW31?')).not.toBeInTheDocument()

    await user.click(screen.getByText('Cancel flight'))
    await user.click(screen.getAllByText('Cancel flight').slice(-1)[0])
    await waitFor(() => expect(winglog.trackingStop).toHaveBeenCalled())
    expect(onFlightEnded).toHaveBeenCalled()
  })

  it('shows a toast if cancelling the active flight fails', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'cruise' }),
      trackingStop: vi.fn().mockRejectedValue(new Error('cannot stop'))
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Cancel flight')
    await user.click(screen.getByText('Cancel flight'))
    await user.click(screen.getAllByText('Cancel flight').slice(-1)[0])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('cannot stop'))
  })

  it('shows a stringified toast if cancelling the active flight fails with a non-Error', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'cruise' }),
      trackingStop: vi.fn().mockRejectedValue('nope')
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Cancel flight')
    await user.click(screen.getByText('Cancel flight'))
    await user.click(screen.getAllByText('Cancel flight').slice(-1)[0])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'))
  })

  it('finishing the active flight confirms, then calls trackingFinish', async () => {
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'landing' })
    })
    const onFlightEnded = vi.fn()
    const user = userEvent.setup()
    renderTrack({ onFlightEnded })
    await screen.findByText('Finish & save')
    await user.click(screen.getByText('Finish & save'))
    expect(await screen.findByText('Finish BAW31 now?')).toBeInTheDocument()
    await user.click(screen.getAllByText('Finish & save').slice(-1)[0])
    await waitFor(() => expect(winglog.trackingFinish).toHaveBeenCalled())
    expect(onFlightEnded).toHaveBeenCalled()
  })

  it('shows a toast if finishing the active flight fails', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'landing' }),
      trackingFinish: vi.fn().mockRejectedValue(new Error('cannot finish'))
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Finish & save')
    await user.click(screen.getByText('Finish & save'))
    await user.click(screen.getAllByText('Finish & save').slice(-1)[0])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('cannot finish'))
  })

  it('shows a stringified toast if finishing the active flight fails with a non-Error', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'landing' }),
      trackingFinish: vi.fn().mockRejectedValue('nope')
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Finish & save')
    await user.click(screen.getByText('Finish & save'))
    await user.click(screen.getAllByText('Finish & save').slice(-1)[0])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'))
  })

  it('cancelling a planned flight confirms, then calls flightCancel', async () => {
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()])
    })
    const onFlightEnded = vi.fn()
    const user = userEvent.setup()
    renderTrack({ onFlightEnded })
    await screen.findByText('Start tracking')
    await user.click(screen.getByText('Cancel flight'))
    expect(await screen.findByText('Cancel BAW31?')).toBeInTheDocument()
    await user.click(screen.getByText('Cancel flight', { selector: 'button[data-slot="alert-dialog-action"]' }))
    await waitFor(() => expect(winglog.flightCancel).toHaveBeenCalledWith(1))
    expect(onFlightEnded).toHaveBeenCalled()
  })

  it('shows a toast if cancelling a planned flight fails', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()]),
      flightCancel: vi.fn().mockRejectedValue(new Error('cannot cancel'))
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Start tracking')
    await user.click(screen.getByText('Cancel flight'))
    await user.click(screen.getByText('Cancel flight', { selector: 'button[data-slot="alert-dialog-action"]' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('cannot cancel'))
  })

  it('shows a stringified toast if cancelling a planned flight fails with a non-Error', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()]),
      flightCancel: vi.fn().mockRejectedValue('nope')
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Start tracking')
    await user.click(screen.getByText('Cancel flight'))
    await user.click(screen.getByText('Cancel flight', { selector: 'button[data-slot="alert-dialog-action"]' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'))
  })

  it('backing out of finishing the active flight leaves it untouched', async () => {
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'landing' })
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Finish & save')
    await user.click(screen.getByText('Finish & save'))
    await screen.findByText('Finish BAW31 now?')
    await user.click(screen.getByText('Back'))
    expect(screen.queryByText('Finish BAW31 now?')).not.toBeInTheDocument()
    expect(winglog.trackingFinish).not.toHaveBeenCalled()
  })

  it('backing out of cancelling a planned flight leaves it untouched', async () => {
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()])
    })
    const user = userEvent.setup()
    renderTrack()
    await screen.findByText('Start tracking')
    await user.click(screen.getByText('Cancel flight'))
    await screen.findByText('Cancel BAW31?')
    await user.click(screen.getByText('Back'))
    expect(screen.queryByText('Cancel BAW31?')).not.toBeInTheDocument()
    expect(winglog.flightCancel).not.toHaveBeenCalled()
  })

  it('pushes the current procedure selection to the main process while a flight is active', async () => {
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'cruise' })
    })
    const selection: ProcedureSelection = { ...emptyProcedureSelection(), sidIdent: 'DET2G' }
    renderTrack({ selection })
    await screen.findByText('cruise')
    await waitFor(() => expect(winglog.trackingSetProcedureSelection).toHaveBeenCalledWith(selection))
  })

  it('does not push a procedure selection when nothing is being tracked', async () => {
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight()])
    })
    renderTrack()
    await screen.findByText('Start tracking')
    expect(winglog.trackingSetProcedureSelection).not.toHaveBeenCalled()
  })

  it('swallows a failure pushing the procedure selection rather than crashing', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'cruise' }),
      trackingSetProcedureSelection: vi.fn().mockRejectedValue(new Error('offline'))
    })
    renderTrack()
    expect(await screen.findByText('cruise')).toBeInTheDocument()
  })

  it('shows the "flight ended" dialog on an auto-detected shutdown and clears the active banner', async () => {
    let pointListener: ((point: TrackPoint) => void) | undefined
    const onFlightEnded = vi.fn()
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active', flightNumber: 'BAW31' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'landing' }),
      onTrackingPoint: vi.fn((listener) => {
        pointListener = listener
        return () => {}
      })
    })
    renderTrack({ onFlightEnded })
    await screen.findByText('landing')

    pointListener?.(makeTrackPoint({ phase: 'shutdown', flightId: 1 }))

    expect(await screen.findByText('Flight ended')).toBeInTheDocument()
    expect(screen.getByText(/BAW31 was automatically detected as complete/)).toBeInTheDocument()
    expect(onFlightEnded).toHaveBeenCalled()

    const user = userEvent.setup()
    await user.click(screen.getByText('OK'))
    expect(screen.queryByText('Flight ended')).not.toBeInTheDocument()
  })

  it('falls back to a bare flight-id label in the "flight ended" dialog when the flight is unknown', async () => {
    let pointListener: ((point: TrackPoint) => void) | undefined
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([]),
      flightList: vi.fn().mockResolvedValue([]),
      onTrackingPoint: vi.fn((listener) => {
        pointListener = listener
        return () => {}
      })
    })
    renderTrack()
    await screen.findByText('No planned flights to track — dispatch one first.')
    pointListener?.(makeTrackPoint({ phase: 'shutdown', flightId: 77 }))
    expect(await screen.findByText(/Flight #77 was automatically detected/)).toBeInTheDocument()
  })

  it('accumulates track points for the same flight and resets on a new flight id', async () => {
    let pointListener: ((point: TrackPoint) => void) | undefined
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'taxi' }),
      onTrackingPoint: vi.fn((listener) => {
        pointListener = listener
        return () => {}
      })
    })
    renderTrack()
    await screen.findByText('taxi')

    pointListener?.(makeTrackPoint({ phase: 'takeoff', flightId: 1 }))
    expect(await screen.findByText('takeoff')).toBeInTheDocument()

    // A point for a different flight id replaces the accumulated trail rather than
    // appending to it.
    pointListener?.(makeTrackPoint({ phase: 'climb', flightId: 2, id: 2 }))
    expect(await screen.findByText('climb')).toBeInTheDocument()
  })

  it('unsubscribes the tracking-point listener on unmount', async () => {
    const unsubscribe = vi.fn()
    setWinglog({ onTrackingPoint: vi.fn(() => unsubscribe) })
    const { unmount } = renderTrack()
    await screen.findByText('No planned flights to track — dispatch one first.')
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('previews the most recently planned flight’s OFP route on the map before tracking starts', async () => {
    const ofpJson = JSON.stringify({
      navlog: { fix: [{ pos_long: '-0.45', pos_lat: '51.47', ident: 'EGLL', via_airway: null }] }
    })
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ ofpJson })])
    })
    renderTrack()
    await screen.findByText('Start tracking')
    // No crash / real FlightMap mounted — route derivation from ofpJson is exercised here
    // even though the mocked maplibre-gl gives us nothing visual to assert against.
  })

  it('falls back to the Dispatch preview OFP when nothing is planned or active yet', async () => {
    const previewOfp = makeDispatchOfp({
      ofpJson: JSON.stringify({
        navlog: { fix: [{ pos_long: '-0.45', pos_lat: '51.47', ident: 'EGLL', via_airway: null }] }
      })
    })
    setWinglog()
    renderTrack({ previewOfp })
    await screen.findByText('No planned flights to track — dispatch one first.')
    // The Dispatch preview still counts as "airports" for the Procedures affordance.
    expect(screen.getByText('Procedures…')).toBeInTheDocument()
  })

  it('has no Procedures affordance without a planned/active flight or a Dispatch preview', async () => {
    setWinglog()
    renderTrack({ previewOfp: null })
    await screen.findByText('No planned flights to track — dispatch one first.')
    expect(screen.queryByText('Procedures…')).not.toBeInTheDocument()
  })

  it('passes live telemetry through to the map without crashing', async () => {
    setWinglog()
    const telemetry: SimTelemetry = {
      latitude: 51.47,
      longitude: -0.45,
      altitudeM: 1000,
      altitudeAglM: 900,
      verticalSpeedMs: 0,
      indicatedAirspeedMs: 120,
      trueAirspeedMs: 130,
      machSpeed: 0.3,
      groundSpeedMs: 125,
      headingTrueDeg: 270,
      pitchDeg: 2,
      bankDeg: 0,
      onGround: false,
      gForce: 1,
      fuelTotalKg: 50000,
      totalWeightKg: 200000,
      windSpeedMs: 5,
      windDirectionDeg: 250,
      engineCombustion1: true,
      gearHandlePosition: 0,
      flapsHandleIndex: 0,
      parkingBrakeOn: false,
      atcId: 'BAW31',
      atcModel: 'A35K',
      title: 'Airbus A350-1000',
      simRate: 1,
      slewActive: false
    }
    renderTrack({ telemetry })
    await screen.findByText('No planned flights to track — dispatch one first.')
  })

  it('loads existing track points for an already-active flight on mount', async () => {
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'cruise' }),
      trackPointList: vi.fn().mockResolvedValue([makeTrackPoint()])
    })
    renderTrack()
    await screen.findByText('cruise')
    expect(winglog.trackPointList).toHaveBeenCalledWith(1)
  })
})
