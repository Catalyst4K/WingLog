import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import i18n from './i18n'
import type {
  Aircraft,
  DispatchOfp,
  Flight,
  FleetStats,
  GsxFirstLaunchResult,
  SimConnectionStatus,
  SimTelemetry,
  SyncStatus,
  WingLogApi
} from '@shared/ipc'
import App from './App'

// Unlike other renderer test files (which never render <Toaster>), App.tsx mounts the real
// one — it re-exports sonner's own Toaster component, so this mock must keep that intact
// (importOriginal) rather than replacing the whole module, or Toaster's own render throws.
vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sonner')>()),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

// Track and Logbook's flight-detail map both mount a real FlightMap, which constructs a
// real maplibre-gl map needing a canvas/WebGL context jsdom doesn't provide — same reason
// FlightMap.test.tsx mocks this module. App.test.tsx only needs the map to construct and
// tear down without throwing; it never asserts against the map itself (that's
// FlightMap.test.tsx's job), so this fake is deliberately minimal.
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

// Radix Select/Tabs reach for pointer-capture/scroll APIs jsdom doesn't implement — see
// every other renderer test file's identical setup.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
  // FlightMap's worker setup fetches a blob: URL — never actually reached in these tests
  // (mocked maplibre-gl has no worker of its own), but the module-level ensureWorkerReady()
  // promise still runs and awaits fetch(), so it must resolve rather than reject/hang.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob()) }))
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:mock')
    }
  )
})

function makeAircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    id: 1,
    registration: 'G-ABCD',
    icaoType: 'A320',
    operator: 'Test Air',
    operatorIata: 'TA',
    operatorIcao: 'TAX',
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
    arrIcao: 'EDDF',
    altnIcao: null,
    routeString: null,
    cruiseAltM: null,
    schedOutUtc: null,
    schedInUtc: null,
    actualOutUtc: '2026-01-01T10:00:00.000Z',
    actualOffUtc: null,
    actualOnUtc: null,
    actualInUtc: null,
    blockMinutes: 90,
    airMinutes: 80,
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

function makeStats(overrides: Partial<FleetStats> = {}): FleetStats {
  return {
    aircraftId: 1,
    registration: 'G-ABCD',
    totalHours: 12.5,
    totalCycles: 4,
    lastArrIcao: 'EGLL',
    lastFlightInUtc: '2026-01-01T12:00:00.000Z',
    ...overrides
  }
}

function makeOfp(overrides: Partial<DispatchOfp> = {}): DispatchOfp {
  return {
    ofpId: 'ofp-1',
    aircraftIcaoType: 'A320',
    aircraftRegistration: 'G-ABCD',
    flightNumber: 'TA100',
    depIcao: 'EGLL',
    arrIcao: 'EDDF',
    altnIcao: 'EDDL',
    routeString: 'DCT',
    cruiseAltM: 10668,
    schedOutUtc: '2026-01-01T10:00:00.000Z',
    schedInUtc: '2026-01-01T12:00:00.000Z',
    fuelPlannedKg: 5000,
    pax: 150,
    cargoKg: 1000,
    zfwKg: 60000,
    towKg: 65000,
    ldwKg: 62000,
    costIndex: 25,
    waypoints: [],
    stepClimbs: [],
    ofpJson: '{}',
    matchedAircraftId: 1,
    simbriefIsCustom: false,
    simbriefInternalId: null,
    ...overrides
  }
}

function makeSyncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return { loggedIn: false, email: null, syncing: false, lastSyncedAt: null, lastError: null, ...overrides }
}

/** Union of every channel any real child view calls on/near mount — App.tsx renders Fleet
 *  eagerly and every other tab is a real child too (per this app's own testing rule: mock
 *  only window.winglog, never a child component), so this has to satisfy whichever tab a
 *  given test navigates to, not just App.tsx's own direct calls. */
function createWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  return {
    // App.tsx itself
    settingsGetWeightUnit: vi.fn().mockResolvedValue('lb'),
    settingsGetAltitudeUnit: vi.fn().mockResolvedValue('ft'),
    settingsGetWindSpeedUnit: vi.fn().mockResolvedValue('kt'),
    settingsGetMapLanguage: vi.fn().mockResolvedValue('en'),
    settingsSetMapLanguage: vi.fn().mockResolvedValue(undefined),
    settingsGetAppLanguage: vi.fn().mockResolvedValue('system'),
    settingsSetAppLanguage: vi.fn().mockResolvedValue(undefined),
    settingsGetSystemLocale: vi.fn().mockResolvedValue('en-US'),
    settingsGetLandingDistanceUnit: vi.fn().mockResolvedValue('ft'),
    settingsGetTheme: vi.fn().mockResolvedValue('system'),
    settingsSetTheme: vi.fn().mockResolvedValue(undefined),
    settingsSetWeightUnit: vi.fn().mockResolvedValue(undefined),
    settingsSetAltitudeUnit: vi.fn().mockResolvedValue(undefined),
    settingsSetWindSpeedUnit: vi.fn().mockResolvedValue(undefined),
    settingsSetLandingDistanceUnit: vi.fn().mockResolvedValue(undefined),
    settingsCheckGsxFirstLaunch: vi.fn().mockResolvedValue(null),
    trackingGetOrphanedFlight: vi.fn().mockResolvedValue(null),
    trackingResumeOrphaned: vi.fn().mockResolvedValue(undefined),
    trackingDiscardOrphaned: vi.fn().mockResolvedValue(undefined),
    dispatchGetInProgressFlight: vi.fn().mockResolvedValue(null),
    getSimConnectionStatus: vi.fn().mockResolvedValue({ state: 'disconnected' } satisfies SimConnectionStatus),
    onSimConnectionStatus: vi.fn(() => () => {}),
    onSimTelemetry: vi.fn(() => () => {}),
    // FleetView (eager)
    aircraftList: vi.fn().mockResolvedValue([]),
    logbookFleetStats: vi.fn().mockResolvedValue([]),
    aircraftCreate: vi.fn(),
    aircraftUpdate: vi.fn(),
    aircraftDelete: vi.fn().mockResolvedValue(undefined),
    aircraftReplace: vi.fn().mockResolvedValue(undefined),
    fleetListLandings: vi.fn().mockResolvedValue([]),
    fleetListFlights: vi.fn().mockResolvedValue([]),
    fleetGetMaintenance: vi.fn().mockResolvedValue(null),
    dispatchOpenSimBriefAirframes: vi.fn().mockResolvedValue(undefined),
    simbriefAirframesForType: vi.fn().mockResolvedValue([]),
    simbriefCreateCustomAirframe: vi.fn().mockResolvedValue(null),
    aircraftLookupByRegistration: vi.fn().mockResolvedValue(null),
    airlineFindByIcao: vi.fn().mockResolvedValue(undefined),
    aircraftTypeSearch: vi.fn().mockResolvedValue([]),
    airlineSearch: vi.fn().mockResolvedValue([]),
    airportSearch: vi.fn().mockResolvedValue([]),
    // DispatchView (lazy)
    dispatchGenerationAvailable: vi.fn().mockResolvedValue(true),
    flightList: vi.fn().mockResolvedValue([]),
    dispatchOpenSimBrief: vi.fn().mockResolvedValue(undefined),
    dispatchGenerateOfp: vi.fn().mockResolvedValue(makeOfp()),
    dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp()),
    trackingGetActive: vi.fn().mockResolvedValue(null),
    dispatchOpenOfpPdf: vi.fn().mockResolvedValue(true),
    flightCreate: vi.fn().mockResolvedValue(makeFlight()),
    weatherGetMetars: vi.fn().mockResolvedValue([]),
    navdataRefreshAirport: vi.fn().mockResolvedValue(undefined),
    navdataHasAirport: vi.fn().mockResolvedValue(false),
    navdataListRunways: vi.fn().mockResolvedValue([]),
    navdataListSids: vi.fn().mockResolvedValue([]),
    navdataListStars: vi.fn().mockResolvedValue([]),
    navdataListApproaches: vi.fn().mockResolvedValue([]),
    navdataGetProcedureWaypoints: vi.fn().mockResolvedValue([]),
    // TrackView (lazy)
    trackPointList: vi.fn().mockResolvedValue([]),
    onTrackingPoint: vi.fn(() => () => {}),
    onTrackingPointsUpdated: vi.fn(() => () => {}),
    trackingStart: vi.fn().mockResolvedValue(undefined),
    trackingStop: vi.fn().mockResolvedValue(undefined),
    trackingFinish: vi.fn().mockResolvedValue(undefined),
    flightCancel: vi.fn().mockResolvedValue(undefined),
    trackingSetDestination: vi.fn().mockResolvedValue(undefined),
    trackingSetDeparture: vi.fn().mockResolvedValue(undefined),
    trackingSetProcedureSelection: vi.fn().mockResolvedValue(undefined),
    // LogbookView (lazy)
    logbookListCompletedFlights: vi.fn().mockResolvedValue([]),
    logbookGetStats: vi.fn().mockResolvedValue({ totalFlights: 0, totalBlockMinutes: 0, totalNm: 0 }),
    logbookListFlightScores: vi.fn().mockResolvedValue([]),
    logbookListLandings: vi.fn().mockResolvedValue([]),
    logbookListAllLandings: vi.fn().mockResolvedValue([]),
    logbookGreatCircleRoute: vi.fn().mockResolvedValue(null),
    logbookListInvoices: vi.fn().mockResolvedValue([]),
    // SettingsView (lazy)
    settingsGetSimbriefUsername: vi.fn().mockResolvedValue(null),
    dispatchSimbriefLoginStatus: vi.fn().mockResolvedValue(false),
    dispatchLoginSimbrief: vi.fn().mockResolvedValue(undefined),
    dispatchFetchSimbriefUsername: vi.fn().mockResolvedValue(null),
    dispatchLogoutSimbrief: vi.fn().mockResolvedValue(undefined),
    settingsGetGsx: vi.fn().mockResolvedValue({ enabled: false, folderPath: null, displayCurrency: 'USD' }),
    settingsSetGsx: vi.fn().mockResolvedValue(undefined),
    gsxBrowseFolder: vi.fn().mockResolvedValue(null),
    settingsGetMaintenanceAddon: vi.fn().mockResolvedValue({ folderPath: null }),
    settingsSetMaintenanceAddon: vi.fn().mockResolvedValue(undefined),
    maintenanceAddonBrowseFolder: vi.fn().mockResolvedValue(null),
    syncStatus: vi.fn().mockResolvedValue(makeSyncStatus()),
    authLogin: vi.fn().mockResolvedValue(makeSyncStatus()),
    authSignup: vi.fn().mockResolvedValue(makeSyncStatus()),
    authLogout: vi.fn().mockResolvedValue(makeSyncStatus()),
    syncNow: vi.fn().mockResolvedValue(makeSyncStatus()),
    logbookImportCsv: vi.fn().mockResolvedValue(null),
    aircraftImport: vi.fn().mockResolvedValue(null),
    aircraftExport: vi.fn().mockResolvedValue(false),
    appGetVersion: vi.fn().mockResolvedValue('1.0.0'),
    appOpenGithub: vi.fn().mockResolvedValue(undefined),
    ...overrides
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function setWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = createWinglog(overrides)
  window.winglog = api
  return api
}

beforeEach(() => {
  setWinglog()
  document.documentElement.classList.remove('dark')
  // jsdom has no real matchMedia — App.tsx's theme-resolution effect calls it unconditionally
  // on every mount, regardless of which theme test actually cares about.
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  )
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  // Re-stub the globals beforeAll set once (afterEach's unstubAllGlobals above clears them
  // for every test after the first) — cheaper than moving them into a per-test beforeEach.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob()) }))
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:mock')
    }
  )
})

async function clickTab(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(screen.getByRole('tab', { name }))
}

describe('App', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders its tabs and connection badge in the active i18next language, not a hardcoded English string', async () => {
    // FleetView (the default tab) isn't itself translated yet — this only asserts App.tsx's
    // own strings, not the still-English view it renders alongside them. The persisted
    // language must be mocked as 'de' explicitly too, or App.tsx's own mount effect
    // resolves 'system' back to English (the default mock) and clobbers this.
    setWinglog({ settingsGetAppLanguage: vi.fn().mockResolvedValue('de') })
    await i18n.changeLanguage('de')
    render(<App />)
    for (const name of ['Flotte', 'Flugplanung', 'Flugverfolgung', 'Logbuch', 'Einstellungen']) {
      expect(await screen.findByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByText('SimConnect: getrennt')).toBeInTheDocument()
  })

  it('shows Fleet by default, with every tab and the SimConnect badge', async () => {
    render(<App />)
    expect(await screen.findByText('Fleet', { selector: 'h1' })).toBeInTheDocument()
    for (const name of ['Fleet', 'Dispatch', 'Track', 'Logbook', 'Settings']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByText('SimConnect: disconnected')).toBeInTheDocument()
  })

  it(
    'navigates to every other tab, lazily loading its real view',
    async () => {
      const user = userEvent.setup()
      render(<App />)
      await screen.findByText('Fleet', { selector: 'h1' })

      // A generous timeout here, not the default ~1s — each of these is a genuine dynamic
      // `import()` (React.lazy) resolving through Suspense for the first time, which is
      // slow under the full test suite's parallel load even though it's instant alone.
      const lazyTimeout = { timeout: 10000 }

      await clickTab(user, 'Dispatch')
      expect(await screen.findByText('Dispatch', { selector: 'h1' }, lazyTimeout)).toBeInTheDocument()

      await clickTab(user, 'Track')
      expect(await screen.findByText('Track', { selector: 'h1' }, lazyTimeout)).toBeInTheDocument()

      await clickTab(user, 'Logbook')
      expect(await screen.findByText('Logbook', { selector: 'h1' }, lazyTimeout)).toBeInTheDocument()

      await clickTab(user, 'Settings')
      expect(await screen.findByText('Settings', { selector: 'h1' }, lazyTimeout)).toBeInTheDocument()

      await clickTab(user, 'Fleet')
      expect(await screen.findByText('Fleet', { selector: 'h1' }, lazyTimeout)).toBeInTheDocument()
    },
    15000
  )

  it('reflects a live SimConnect status push, and clears telemetry once disconnected', async () => {
    let statusListener: ((status: SimConnectionStatus) => void) | undefined
    let telemetryListener: ((t: SimTelemetry) => void) | undefined
    setWinglog({
      onSimConnectionStatus: vi.fn((listener) => {
        statusListener = listener
        return () => {}
      }),
      onSimTelemetry: vi.fn((listener) => {
        telemetryListener = listener
        return () => {}
      }),
      // The map overlay only reads live telemetry once tracking has started
      // (docs/plans/beta-ui-polish.md item 1), so this needs an active flight.
      trackingGetActive: vi.fn().mockResolvedValue({ flightId: 1, phase: 'cruise' })
    })
    render(<App />)
    await screen.findByText('Fleet', { selector: 'h1' })

    statusListener?.({ state: 'connecting' })
    expect(await screen.findByText('SimConnect: connecting')).toBeInTheDocument()

    statusListener?.({ state: 'connected', simConnectVersion: '12.2' })
    expect(await screen.findByText('SimConnect: connected')).toBeInTheDocument()
    expect(screen.getByTitle('Connected (SimConnect 12.2)')).toBeInTheDocument()

    // Telemetry only matters visibly once Track is open (its map overlay reads it) — confirm
    // it clears there rather than staying frozen once the sim disconnects.
    telemetryListener?.({ indicatedAirspeedMs: 100 } as SimTelemetry)
    const user = userEvent.setup()
    await clickTab(user, 'Track')
    await screen.findByText(/Speed: 194 kt/)

    statusListener?.({ state: 'disconnected' })
    expect(await screen.findByText('SimConnect: disconnected')).toBeInTheDocument()
    expect(await screen.findByText(/Speed: N\/A/)).toBeInTheDocument()
  })

  it('loads persisted unit and theme settings once on mount', async () => {
    setWinglog({ settingsGetTheme: vi.fn().mockResolvedValue('dark') })
    render(<App />)
    await screen.findByText('Fleet', { selector: 'h1' })
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true))
  })

  it('persists every unit change from Settings, and threads the new value back to every view', async () => {
    const winglog = setWinglog()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('Fleet', { selector: 'h1' })

    await clickTab(user, 'Settings')
    await screen.findByText('Units')

    await user.click(screen.getByRole('button', { name: 'lb' }))
    expect(winglog.settingsSetWeightUnit).toHaveBeenCalledWith('lb')

    const altitudeRow = screen.getByRole('group', { name: 'OFP altitudes' })
    await user.click(within(altitudeRow).getByRole('button', { name: 'Meters' }))
    expect(winglog.settingsSetAltitudeUnit).toHaveBeenCalledWith('m')

    await user.click(screen.getByRole('button', { name: 'm/s' }))
    expect(winglog.settingsSetWindSpeedUnit).toHaveBeenCalledWith('mps')

    const landingRow = screen.getByRole('group', { name: 'Landing distances' })
    await user.click(within(landingRow).getByRole('button', { name: 'Meters' }))
    expect(winglog.settingsSetLandingDistanceUnit).toHaveBeenCalledWith('m')

    await user.click(screen.getByRole('button', { name: 'Dark' }))
    expect(winglog.settingsSetTheme).toHaveBeenCalledWith('dark')
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true))
  })

  it('follows an OS scheme change while the theme is "system"', async () => {
    let changeListener: (() => void) | undefined
    let matches = false
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        get matches() {
          return matches
        },
        addEventListener: (_event: string, cb: () => void) => {
          changeListener = cb
        },
        removeEventListener: vi.fn()
      })
    )
    setWinglog({ settingsGetTheme: vi.fn().mockResolvedValue('system') })
    render(<App />)
    await screen.findByText('Fleet', { selector: 'h1' })
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    matches = true
    changeListener?.()
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true))
  })

  it('shows the resume-tracking prompt for a genuinely active orphaned flight, and resumes it', async () => {
    const orphan = makeFlight({ id: 5, status: 'active', flightNumber: 'BAW31' })
    const winglog = setWinglog({ trackingGetOrphanedFlight: vi.fn().mockResolvedValue(orphan) })
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText('Resume tracking?')).toBeInTheDocument()
    expect(screen.getByText(/WingLog closed while BAW31 was being tracked/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Resume tracking' }))
    expect(winglog.trackingResumeOrphaned).toHaveBeenCalledWith(5)
    expect(await screen.findByText('Track', { selector: 'h1' })).toBeInTheDocument()
    expect(screen.queryByText('Resume tracking?')).not.toBeInTheDocument()
  })

  it('shows the continue-flight prompt for a merely planned orphaned flight, and discards it', async () => {
    const orphan = makeFlight({ id: 6, status: 'planned', flightNumber: null, depIcao: 'EGLL', arrIcao: 'KJFK' })
    const winglog = setWinglog({ trackingGetOrphanedFlight: vi.fn().mockResolvedValue(orphan) })
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText('Continue this flight?')).toBeInTheDocument()
    expect(screen.getByText(/EGLL → KJFK already planned but not yet started/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Discard flight' }))
    expect(winglog.trackingDiscardOrphaned).toHaveBeenCalledWith(6)
    await waitFor(() => expect(screen.queryByText('Continue this flight?')).not.toBeInTheDocument())
  })

  it('clears a matching in-progress Dispatch view when its orphaned flight is discarded', async () => {
    const ofp = makeOfp({ ofpId: 'ofp-42' })
    const orphan = makeFlight({ id: 7, status: 'planned', ofpId: 'ofp-42' })
    const winglog = setWinglog({
      trackingGetOrphanedFlight: vi.fn().mockResolvedValue(orphan),
      dispatchGetInProgressFlight: vi.fn().mockResolvedValue({ flight: orphan, ofp })
    })
    const user = userEvent.setup()
    render(<App />)
    // The orphaned-flight prompt is a real modal — Radix aria-hides the tab bar underneath
    // it while it's open, so the tab bar genuinely can't be interacted with yet, matching
    // real usage (the user must resolve the prompt before doing anything else).
    await screen.findByText('Continue this flight?')

    await user.click(screen.getByRole('button', { name: 'Discard flight' }))
    await waitFor(() => expect(winglog.trackingDiscardOrphaned).toHaveBeenCalledWith(7))
    await waitFor(() => expect(screen.queryByText('Continue this flight?')).not.toBeInTheDocument())

    await clickTab(user, 'Dispatch')
    expect(
      screen.queryByText(`${ofp.flightNumber}: ${ofp.depIcao} → ${ofp.arrIcao} (altn ${ofp.altnIcao})`)
    ).not.toBeInTheDocument()
  })

  it('restores Dispatch’s own view of an in-progress flight after a restart', async () => {
    const ofp = makeOfp()
    const inProgress = makeFlight({ status: 'planned', ofpId: ofp.ofpId })
    setWinglog({ dispatchGetInProgressFlight: vi.fn().mockResolvedValue({ flight: inProgress, ofp }) })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('Fleet', { selector: 'h1' })

    await clickTab(user, 'Dispatch')
    expect(await screen.findByText(`${ofp.flightNumber}: ${ofp.depIcao} → ${ofp.arrIcao} (altn ${ofp.altnIcao})`)).toBeInTheDocument()
  })

  it('keeps a lifted OFP alive across a Dispatch -> Track -> Dispatch round trip', async () => {
    setWinglog({ dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp()) })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('Fleet', { selector: 'h1' })

    await clickTab(user, 'Dispatch')
    await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))
    await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')

    await clickTab(user, 'Track')
    // Track's own live-route preview draws the same OFP's route — its Procedures button
    // only appears once an OFP/flight is available to preview.
    expect(await screen.findByRole('button', { name: 'Procedures…' })).toBeInTheDocument()

    await clickTab(user, 'Dispatch')
    expect(await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')).toBeInTheDocument()
  })

  it('shows a success toast when GSX is auto-enabled on first launch, and an info toast when it is not', async () => {
    setWinglog({
      settingsCheckGsxFirstLaunch: vi.fn().mockResolvedValue({ found: true } satisfies GsxFirstLaunchResult)
    })
    render(<App />)
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'GSX ground-service tracking enabled — receipts folder found automatically.'
      )
    )
  })

  it('shows an info toast when GSX is not found on first launch', async () => {
    setWinglog({
      settingsCheckGsxFirstLaunch: vi.fn().mockResolvedValue({ found: false } satisfies GsxFirstLaunchResult)
    })
    render(<App />)
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('GSX ground-service tracking is off — enable it in Settings if you use GSX.')
    )
  })

  it('does not toast at all on every ordinary launch after the first', async () => {
    setWinglog({ settingsCheckGsxFirstLaunch: vi.fn().mockResolvedValue(null) })
    render(<App />)
    await screen.findByText('Fleet', { selector: 'h1' })
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('re-clicking the active Settings tab returns it to the UI category', async () => {
    setWinglog()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('Fleet', { selector: 'h1' })

    await clickTab(user, 'Settings')
    await screen.findByText('Units')
    await user.click(screen.getByRole('tab', { name: 'About' }))
    await screen.findByText(/WingLog v1\.0\.0/)

    await clickTab(user, 'Settings')
    expect(await screen.findByText('Units')).toBeInTheDocument()
  })

  it('opens a specific flight in Logbook from a Fleet aircraft’s flight list, and returns to that aircraft', async () => {
    const aircraft = makeAircraft()
    const flight = makeFlight({ id: 9, flightNumber: 'BA900', depIcao: 'EGLL', arrIcao: 'KJFK' })
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([aircraft]),
      logbookFleetStats: vi.fn().mockResolvedValue([makeStats({ aircraftId: 1 })]),
      fleetListFlights: vi.fn().mockResolvedValue([flight]),
      logbookListCompletedFlights: vi.fn().mockResolvedValue([flight])
    })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('G-ABCD')

    await user.click(screen.getByText('G-ABCD'))
    await user.click(await screen.findByRole('button', { name: /BA900/ }))

    expect(await screen.findByText(/BA900.*EGLL.*KJFK/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back to aircraft' }))
    expect(await screen.findByText('G-ABCD — A320')).toBeInTheDocument()
  })
})
