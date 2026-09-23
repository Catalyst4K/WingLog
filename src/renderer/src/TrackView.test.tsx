import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
import i18n from './i18n'
import { emptyProcedureSelection } from './procedureSelection'
import { TrackView } from './TrackView'

// sonner's real toast has nothing to render into in these tests (no <Toaster/> mounted)
// and isn't a spy — mock it so `toast.error`/`toast.success` assertions work, matching the
// one IPC-adjacent seam (window.winglog) this batch's other tests mock.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// jsdom has no real pointer-capture implementation, which Radix's Select throws on when a
// test actually opens the dropdown (rather than relying on its default selection) — same
// polyfill DispatchView.test.tsx/FleetView.test.tsx/SettingsView.test.tsx already needed.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})

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
  retiredAt: null,
  photoThumbnailUrl: null
}

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 1,
    aircraftId: 1,
    simRegistration: null,
    simIcaoType: null,
    simTitle: null,
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
    selectedArrivalIcao: null,
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
    pressureAltitudeM: null,
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
    onTrackingPointsUpdated: vi.fn(() => () => {}),
    trackingStart: vi.fn().mockResolvedValue(undefined),
    trackingStartFree: vi.fn().mockResolvedValue(1),
    trackingGetFreeFlightPrefill: vi.fn().mockResolvedValue({
      registration: 'TEST',
      icaoType: null,
      icaoTypeAmbiguous: false,
      suggestedDepIcao: null,
      rememberedAircraftId: null
    }),
    aircraftCreate: vi.fn().mockResolvedValue(AIRCRAFT),
    aircraftTypeSearch: vi.fn().mockResolvedValue([]),
    airportSearch: vi.fn().mockResolvedValue([]),
    trackingStop: vi.fn().mockResolvedValue(undefined),
    trackingFinish: vi.fn().mockResolvedValue(undefined),
    flightCancel: vi.fn().mockResolvedValue(undefined),
    trackingSetDestination: vi.fn().mockResolvedValue(undefined),
    trackingSetDeparture: vi.fn().mockResolvedValue(undefined),
    weatherGetMetars: vi.fn().mockResolvedValue([]),
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

function makeTelemetry(overrides: Partial<SimTelemetry> = {}): SimTelemetry {
  return {
    latitude: 51.4775,
    longitude: -0.4614,
    altitudeM: 25,
    pressureAltitudeM: 25,
    altitudeAglM: 0,
    verticalSpeedMs: 0,
    indicatedAirspeedMs: 0,
    trueAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    onGround: true,
    gForce: 1,
    fuelTotalKg: 10000,
    totalWeightKg: 70000,
    windSpeedMs: 3,
    windDirectionDeg: 250,
    engineCombustion1: false,
    gearHandlePosition: 1,
    flapsHandleIndex: 0,
    parkingBrakeOn: true,
    atcId: 'G-EUYY',
    atcModel: 'A320',
    title: 'Test Aircraft',
    simRate: 1,
    slewActive: false,
    ...overrides
  }
}

/** Feeds one telemetry sample through rerender, as a fresh object each time — mirrors the
 *  sim's real ~1Hz push, where every sample is a new object reference. TrackView.tsx's
 *  passive banner counts consecutive samples by that reference changing, so a test that
 *  wants to simulate several real ticks (rather than one static prop) needs to rerender with
 *  a new object each time, not just pass the same telemetry once. */
function pushTelemetry(
  rerender: ReturnType<typeof render>['rerender'],
  overrides: Partial<SimTelemetry> = {}
): void {
  rerender(
    <TrackView
      telemetry={makeTelemetry(overrides)}
      selection={emptyProcedureSelection()}
      onSelectionChange={vi.fn()}
    />
  )
}

describe('TrackView', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders its title and free-flight card in the active i18next language, not a hardcoded English string', async () => {
    await i18n.changeLanguage('de')
    setWinglog()
    renderTrack()
    expect(screen.getByText('Flugverfolgung')).toBeInTheDocument()
    expect(await screen.findByText('Fliegst du schon etwas?')).toBeInTheDocument()
    expect(screen.getByText('Freier Flug')).toBeInTheDocument()
  })

  it('shows the Free flight card in place of the old dead-end empty state when nothing is planned or active', async () => {
    setWinglog()
    renderTrack()
    expect(await screen.findByText('Flying something already?')).toBeInTheDocument()
    expect(screen.getByText('Free flight')).toBeInTheDocument()
    // Nothing planned/active/preview — no Procedures affordance either.
    expect(screen.queryByText('Procedures…')).not.toBeInTheDocument()
  })

  describe('free-flight destination while tracking (v1.1.1)', () => {
    /** The airport box in the "Departure" / "Destination" row of the free-flight card. */
    function boxFor(label: 'Departure' | 'Destination'): HTMLInputElement {
      return screen.getByText(label).closest('div')!.querySelector('input')!
    }

    function activeFree(overrides: Partial<Flight> = {}): Flight {
      return makeFlight({
        id: 5,
        status: 'active',
        aircraftId: null,
        simRegistration: 'G-TEST',
        simIcaoType: 'C172',
        flightNumber: null,
        ofpJson: null,
        depIcao: 'VHHH',
        arrIcao: 'ZZZZ',
        ...overrides
      })
    }

    it('shows an unset destination as Unknown, and setting one calls the IPC and reloads the flight', async () => {
      const trackingSetDestination = vi.fn().mockResolvedValue(undefined)
      const flightList = vi
        .fn()
        .mockResolvedValueOnce([activeFree()])
        .mockResolvedValue([activeFree({ arrIcao: 'VHHX' })])
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([]),
        flightList,
        trackingSetDestination,
        trackingGetActive: vi.fn().mockResolvedValue({ flightId: 5, phase: 'cruise' })
      })
      const user = userEvent.setup()
      renderTrack()

      await screen.findByText('Destination')
      expect(boxFor('Destination')).toHaveValue('')
      expect(screen.queryByRole('button', { name: 'Set destination' })).not.toBeInTheDocument() // nothing typed yet
      await user.type(boxFor('Destination'), 'vhhx')
      await user.click(screen.getByRole('button', { name: 'Set destination' }))

      await waitFor(() => expect(trackingSetDestination).toHaveBeenCalledWith('VHHX'))
      await waitFor(() => expect(boxFor('Destination')).toHaveValue('VHHX'))
      expect(screen.getByRole('button', { name: 'Clear destination' })).toBeInTheDocument()
    })

    it('clears an existing destination with null', async () => {
      const trackingSetDestination = vi.fn().mockResolvedValue(undefined)
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([]),
        flightList: vi.fn().mockResolvedValue([activeFree({ arrIcao: 'VHHX' })]),
        trackingSetDestination,
        trackingGetActive: vi.fn().mockResolvedValue({ flightId: 5, phase: 'cruise' })
      })
      const user = userEvent.setup()
      renderTrack()
      await user.click(await screen.findByRole('button', { name: 'Clear destination' }))
      await waitFor(() => expect(trackingSetDestination).toHaveBeenCalledWith(null))
    })

    it('surfaces a rejected update as a toast, and is not offered for a planned (OFP) flight', async () => {
      const trackingSetDestination = vi.fn().mockRejectedValue(new Error('That is not a valid airport code'))
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([]),
        flightList: vi.fn().mockResolvedValue([activeFree()]),
        trackingSetDestination,
        trackingGetActive: vi.fn().mockResolvedValue({ flightId: 5, phase: 'cruise' })
      })
      const user = userEvent.setup()
      const view = renderTrack()
      await screen.findByText('Destination')
      await user.type(boxFor('Destination'), 'EGLL')
      await user.click(screen.getByRole('button', { name: 'Set destination' }))
      await waitFor(() => expect(trackingSetDestination).toHaveBeenCalled())
      view.unmount()

      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([]),
        flightList: vi.fn().mockResolvedValue([makeFlight({ id: 5, status: 'active', ofpJson: '{}' })]),
        trackingGetActive: vi.fn().mockResolvedValue({ flightId: 5, phase: 'cruise' })
      })
      renderTrack()
      await screen.findByText('Phase:')
      expect(screen.queryByText('Destination')).not.toBeInTheDocument()
    })

    it('sets the departure the same way, and both feed the Weather dialog (Dep / Dest tabs) apart from Custom', async () => {
      const trackingSetDeparture = vi.fn().mockResolvedValue(undefined)
      const weatherGetMetars = vi.fn().mockResolvedValue([])
      const flightList = vi
        .fn()
        .mockResolvedValueOnce([activeFree({ depIcao: 'ZZZZ', arrIcao: 'VHHX' })])
        .mockResolvedValue([activeFree({ depIcao: 'VHHH', arrIcao: 'VHHX' })])
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([]),
        flightList,
        trackingSetDeparture,
        weatherGetMetars,
        trackingGetActive: vi.fn().mockResolvedValue({ flightId: 5, phase: 'cruise' })
      })
      const user = userEvent.setup()
      renderTrack()

      await screen.findByText('Departure')
      expect(boxFor('Departure')).toHaveValue('')
      await user.type(boxFor('Departure'), 'vhhh')
      await user.click(screen.getByRole('button', { name: 'Set departure' }))
      await waitFor(() => expect(trackingSetDeparture).toHaveBeenCalledWith('VHHH'))
      await waitFor(() => expect(boxFor('Departure')).toHaveValue('VHHH'))

      await user.click(screen.getByRole('button', { name: 'Weather…' }))
      await waitFor(() => expect(weatherGetMetars).toHaveBeenCalledWith(expect.arrayContaining(['VHHH', 'VHHX'])))
      expect(screen.getByRole('tab', { name: 'Dep' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Dest' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Custom' })).toBeInTheDocument()
    })

    it('offers the Weather dialog (Custom still usable) even before any airport is known', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([]),
        flightList: vi.fn().mockResolvedValue([activeFree({ depIcao: 'ZZZZ', arrIcao: 'ZZZZ' })]),
        trackingGetActive: vi.fn().mockResolvedValue({ flightId: 5, phase: 'cruise' })
      })
      const user = userEvent.setup()
      renderTrack()
      await user.click(await screen.findByRole('button', { name: 'Weather…' }))
      expect(await screen.findByRole('tab', { name: 'Custom' })).toBeInTheDocument()
    })

    it('hides the Procedures button while neither airport is known', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([]),
        flightList: vi.fn().mockResolvedValue([activeFree({ depIcao: 'ZZZZ' })]),
        trackingGetActive: vi.fn().mockResolvedValue({ flightId: 5, phase: 'cruise' })
      })
      renderTrack()
      await screen.findByText('Destination')
      expect(screen.queryByRole('button', { name: 'Procedures…' })).not.toBeInTheDocument()
    })
  })

  describe('free flight (free-flight-tracking.md)', () => {
    it('opens the Start a free flight dialog from the Free flight card', async () => {
      setWinglog()
      const user = userEvent.setup()
      renderTrack({ telemetry: makeTelemetry() })
      await user.click(await screen.findByText('Free flight'))
      expect(await screen.findByText('Start a free flight')).toBeInTheDocument()
    })

    it('shows a toast instead of opening the dialog when the sim is not connected', async () => {
      const { toast } = await import('sonner')
      setWinglog()
      const user = userEvent.setup()
      renderTrack({ telemetry: null })
      await user.click(await screen.findByText('Free flight'))
      expect(screen.queryByText('Start a free flight')).not.toBeInTheDocument()
      expect(toast.error).toHaveBeenCalledWith('Not connected to the sim.')
    })

    it('shows the passive detection banner once the sim reports the aircraft airborne for several consecutive samples', async () => {
      setWinglog()
      const { rerender } = renderTrack({ telemetry: makeTelemetry({ onGround: true, groundSpeedMs: 0 }) })
      for (let i = 0; i < 8; i++) pushTelemetry(rerender, { onGround: false })
      expect(await screen.findByText(/G-EUYY is airborne — start tracking\?/)).toBeInTheDocument()
    })

    it('does not show the banner until the sustain threshold is reached — 8 consecutive samples, matching AutoStartDetector\'s own proven bar', async () => {
      setWinglog()
      const { rerender } = renderTrack({ telemetry: makeTelemetry({ onGround: true, groundSpeedMs: 0 }) })
      for (let i = 0; i < 7; i++) pushTelemetry(rerender, { onGround: false })
      expect(screen.queryByText(/start tracking\?/)).not.toBeInTheDocument()
      pushTelemetry(rerender, { onGround: false }) // the 8th sample
      expect(await screen.findByText(/start tracking\?/)).toBeInTheDocument()
    })

    it('shows the banner for ground movement too, not just airborne', async () => {
      setWinglog()
      const { rerender } = renderTrack({ telemetry: makeTelemetry({ onGround: true, groundSpeedMs: 0 }) })
      for (let i = 0; i < 8; i++) pushTelemetry(rerender, { onGround: true, groundSpeedMs: 5 })
      expect(await screen.findByText(/G-EUYY is moving on the ground — start tracking\?/)).toBeInTheDocument()
    })

    it('does not show the banner from a single transient telemetry sample — a real leftover/garbage blip Callum saw live (docs/simconnect-notes.md, 2026-09-16)', async () => {
      setWinglog()
      const { rerender } = renderTrack({ telemetry: makeTelemetry({ onGround: true, groundSpeedMs: 0 }) })
      // One bad sample claiming airborne, then straight back to parked — exactly what a
      // stale/leftover SimConnect read looked like in practice.
      pushTelemetry(rerender, { onGround: false })
      pushTelemetry(rerender, { onGround: true, groundSpeedMs: 0 })
      pushTelemetry(rerender, { onGround: true, groundSpeedMs: 0 })
      expect(screen.queryByText(/start tracking\?/)).not.toBeInTheDocument()
    })

    it('does not show the banner for a stationary, parked aircraft', async () => {
      setWinglog()
      renderTrack({ telemetry: makeTelemetry({ onGround: true, groundSpeedMs: 0 }) })
      await screen.findByText('Free flight') // wait for the view to settle
      expect(screen.queryByText(/start tracking\?/)).not.toBeInTheDocument()
    })

    it('does not show the banner while a flight is already being tracked', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
        flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
        trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'cruise' })
      })
      renderTrack({ telemetry: makeTelemetry({ onGround: false }) })
      await screen.findByText('cruise') // wait for the active-flight card to settle
      expect(screen.queryByText(/start tracking\?/)).not.toBeInTheDocument()
    })

    it('hides the Free flight card once a real flight plan is loaded (dispatched via "Fly")', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
        flightList: vi.fn().mockResolvedValue([makeFlight()])
      })
      renderTrack()
      // Wait for the planned flight's own card to settle rather than asserting on absence
      // immediately, which would pass trivially before the flightList fetch resolves.
      await screen.findByText('Start tracking')
      expect(screen.queryByText('Flying something already?')).not.toBeInTheDocument()
      expect(screen.queryByText('Free flight')).not.toBeInTheDocument()
    })

    it('suppresses the detection banner too once a real flight plan is loaded', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
        flightList: vi.fn().mockResolvedValue([makeFlight()])
      })
      renderTrack({ telemetry: makeTelemetry({ onGround: false }) })
      await screen.findByText('Start tracking') // wait for the planned-flight card to settle
      expect(screen.queryByText(/start tracking\?/)).not.toBeInTheDocument()
    })

    it('dismisses the banner without opening the dialog, and it stays hidden until the episode resets', async () => {
      setWinglog()
      const user = userEvent.setup()
      const { rerender } = renderTrack({ telemetry: makeTelemetry({ onGround: true, groundSpeedMs: 0 }) })
      for (let i = 0; i < 8; i++) pushTelemetry(rerender, { onGround: false })
      await screen.findByText(/start tracking\?/)
      await user.click(screen.getByText('Not now'))
      expect(screen.queryByText(/start tracking\?/)).not.toBeInTheDocument()
      expect(screen.queryByText('Start a free flight')).not.toBeInTheDocument()

      // Still airborne, same episode — stays dismissed.
      pushTelemetry(rerender, { onGround: false, groundSpeedMs: 1 })
      expect(screen.queryByText(/start tracking\?/)).not.toBeInTheDocument()

      // Parked again — the episode ends, clearing the dismissal.
      pushTelemetry(rerender, { onGround: true, groundSpeedMs: 0 })
      expect(screen.queryByText(/start tracking\?/)).not.toBeInTheDocument()

      // Airborne again — a new episode, but a lone sample still isn't enough to prompt yet.
      pushTelemetry(rerender, { onGround: false })
      expect(screen.queryByText(/start tracking\?/)).not.toBeInTheDocument()

      // Sustained across enough more samples — prompts again. (The lone sample above already
      // counted as 1 of the 8 needed, so 7 more reaches the threshold.)
      for (let i = 0; i < 7; i++) pushTelemetry(rerender, { onGround: false })
      expect(await screen.findByText(/start tracking\?/)).toBeInTheDocument()
    })

    it('clears a dismissal on a title change even when the raw trigger never goes false in between — the real bug Callum hit (dismissed a false pre-load trigger, which blended straight into the real flight\'s own trigger, and the banner never came back)', async () => {
      setWinglog()
      const user = userEvent.setup()
      const { rerender } = renderTrack({ telemetry: makeTelemetry({ onGround: true, groundSpeedMs: 0 }) })
      // The false pre-load episode — sustained long enough to prompt, then dismissed.
      for (let i = 0; i < 8; i++) pushTelemetry(rerender, { onGround: false, title: 'Stale previous session' })
      await screen.findByText(/start tracking\?/)
      await user.click(screen.getByText('Not now'))
      expect(screen.queryByText(/start tracking\?/)).not.toBeInTheDocument()

      // The real flight loads — title changes, but the raw trigger stays true throughout
      // (no parked/settled moment in between, unlike the ordinary episode-reset case above).
      // Under the old logic (reset only on the raw trigger going false) this would stay
      // dismissed forever. Sustaining across the new episode's own 8 samples should prompt
      // again regardless.
      for (let i = 0; i < 8; i++) pushTelemetry(rerender, { onGround: false, title: 'FenixA320 IAE SL' })
      expect(await screen.findByText(/start tracking\?/)).toBeInTheDocument()
    })

    it('starts tracking a free flight end to end: prefill, a remembered title match, and the resulting active card', async () => {
      const trackingStartFree = vi.fn().mockResolvedValue(5)
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
        flightList: vi.fn().mockResolvedValue([]),
        trackingStartFree,
        trackingGetFreeFlightPrefill: vi.fn().mockResolvedValue({
          registration: 'F-WWTD', // deliberately doesn't match AIRCRAFT's own registration —
          // resolution is title-memory only now, not a registration match.
          icaoType: 'A35K',
          icaoTypeAmbiguous: false,
          suggestedDepIcao: 'EGLL',
          rememberedAircraftId: AIRCRAFT.id
        }),
        trackingGetActive: vi
          .fn()
          .mockResolvedValueOnce(null) // initial mount
          .mockResolvedValue({ flightId: 5, phase: 'preflight' }) // after starting
      })
      const user = userEvent.setup()
      renderTrack({ telemetry: makeTelemetry() })

      await user.click(await screen.findByText('Free flight'))
      await screen.findByText('Start a free flight')
      // The remembered title -> aircraft match resolves automatically — no manual pick needed.
      await waitFor(() => expect(screen.getByText(`${AIRCRAFT.registration} — ${AIRCRAFT.icaoType}`)).toBeInTheDocument())

      await user.click(screen.getByText('Start tracking'))

      expect(trackingStartFree).toHaveBeenCalledWith({
        aircraftId: AIRCRAFT.id,
        simRegistration: null,
        simIcaoType: null,
        depIcao: 'EGLL',
        arrIcao: null,
        flightNumber: null
      })
      expect(await screen.findByText('Phase:')).toBeInTheDocument()
    })

    it('shows the flight\'s own sim-reported identity in the active card when tracking with no fleet aircraft — not mandatory to add one', async () => {
      const trackingStartFree = vi.fn().mockResolvedValue(5)
      const freeFlight = makeFlight({
        id: 5,
        status: 'active',
        aircraftId: null,
        simRegistration: 'G-TEST',
        simIcaoType: 'C172',
        flightNumber: null,
        ofpJson: null
      })
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([]),
        flightList: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([freeFlight]),
        trackingStartFree,
        trackingGetFreeFlightPrefill: vi.fn().mockResolvedValue({
          registration: 'G-TEST',
          icaoType: 'C172',
          icaoTypeAmbiguous: false,
          suggestedDepIcao: null,
          rememberedAircraftId: null
        }),
        trackingGetActive: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({ flightId: 5, phase: 'preflight' })
      })
      const user = userEvent.setup()
      renderTrack({ telemetry: makeTelemetry({ atcId: 'G-TEST', atcModel: 'C172' }) })

      await user.click(await screen.findByText('Free flight'))
      await screen.findByText('Start a free flight')
      await user.click(screen.getByRole('combobox'))
      await user.click(await screen.findByRole('option', { name: 'None' }))
      await user.click(screen.getByText('Start tracking'))

      expect(await screen.findByText('Phase:')).toBeInTheDocument()
      expect(screen.getByText('C172 · G-TEST')).toBeInTheDocument()
    })
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

  it('falls back to a generic label (never the database id) when the active flight is not in the flight list', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([]),
      flightList: vi.fn().mockResolvedValue([]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 42, phase: 'taxi' })
    })
    renderTrack()
    expect(await screen.findByText('this flight')).toBeInTheDocument()
    expect(screen.queryByText(/#42/)).not.toBeInTheDocument()
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

  it('falls back to a generic label (never the database id) in the "flight ended" banner when the flight is unknown', async () => {
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
    await screen.findByText('Flying something already?')
    pointListener?.(makeTrackPoint({ phase: 'shutdown', flightId: 77 }))
    expect(await screen.findByText(/This flight was automatically detected/)).toBeInTheDocument()
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
    await screen.findByText('Flying something already?')
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
    await screen.findByText('Flying something already?')
    // The Dispatch preview still counts as "airports" for the Procedures affordance.
    expect(screen.getByText('Procedures…')).toBeInTheDocument()
  })

  it('has no Procedures affordance without a planned/active flight or a Dispatch preview', async () => {
    setWinglog()
    renderTrack({ previewOfp: null })
    await screen.findByText('Flying something already?')
    expect(screen.queryByText('Procedures…')).not.toBeInTheDocument()
  })

  const OVERLAY_TELEMETRY: SimTelemetry = {
    latitude: 51.47,
    longitude: -0.45,
    altitudeM: 1000,
    pressureAltitudeM: 1000,
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

  it('keeps the map overlay at N/A while telemetry is present but no flight is being tracked', async () => {
    setWinglog()
    renderTrack({ telemetry: OVERLAY_TELEMETRY })
    await screen.findByText('Flying something already?')
    expect(screen.getByText(/Speed: N\/A/)).toBeInTheDocument()
    expect(screen.queryByText(/Heading: 270°/)).not.toBeInTheDocument()
  })

  it('populates the map overlay from live telemetry once tracking is active', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([AIRCRAFT]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ status: 'active' })]),
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'taxi' })
    })
    renderTrack({ telemetry: OVERLAY_TELEMETRY })
    await screen.findByText('taxi')
    expect(screen.getByText(/Heading: 270°/)).toBeInTheDocument()
    expect(screen.getByText(/Speed: 233 kt/)).toBeInTheDocument()
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
