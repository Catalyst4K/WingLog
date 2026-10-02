import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SimTelemetry, TrackPoint } from '@shared/ipc'
import type { Waypoint } from './route'
import i18n from './i18n'
import type { FlightMapProps } from './FlightMap'

/** The mocked maplibre-gl Map's real shape — deliberately not the real library's own `Map`
 *  type, which has none of the extra test surface (sources/layers/handlers,
 *  fireStyleLoad) this fake exposes for assertions. */
interface FakeMapInstance {
  controls: { opts?: { unit?: string } }[]
  addControl: ReturnType<typeof vi.fn>
  removeControl: ReturnType<typeof vi.fn>
  getLayer: (id: string) => unknown
  styleLayers: unknown[]
  getStyle: ReturnType<typeof vi.fn>
  setLayerZoomRange: ReturnType<typeof vi.fn>
  container: HTMLElement
  style: string
  center: unknown
  zoom: number
  handlers: Record<string, ((e?: { originalEvent?: unknown }) => void)[]>
  sources: Record<string, { setData: ReturnType<typeof vi.fn> }>
  layers: Record<string, { paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }>
  setFilter: ReturnType<typeof vi.fn>
  dragPan: { enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn> }
  keyboard: {
    enable: ReturnType<typeof vi.fn>
    disable: ReturnType<typeof vi.fn>
    disableRotation: ReturnType<typeof vi.fn>
  }
  scrollZoom: { enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn> }
  touchZoomRotate: {
    enable: ReturnType<typeof vi.fn>
    disable: ReturnType<typeof vi.fn>
    disableRotation: ReturnType<typeof vi.fn>
  }
  doubleClickZoom: { enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn> }
  fitBounds: ReturnType<typeof vi.fn>
  jumpTo: ReturnType<typeof vi.fn>
  easeTo: ReturnType<typeof vi.fn>
  zoomIn: ReturnType<typeof vi.fn>
  zoomOut: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  setLayoutProperty: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  getCenter(): { toArray: () => [number, number] }
  getZoom(): number
  fireStyleLoad(): void
}

interface FakeMarkerInstance {
  setLngLat: ReturnType<typeof vi.fn>
  setRotation: ReturnType<typeof vi.fn>
  addTo: ReturnType<typeof vi.fn>
  getElement(): HTMLElement
  remove(): this
}

// FlightMap renders a real maplibre-gl map, which needs a real canvas/WebGL context that
// jsdom doesn't provide (docs/plans/test-coverage.md's open question for this file). The
// approach taken here — per the plan's own suggested carve-out — is to mock 'maplibre-gl'
// with a minimal fake Map/Marker whose surface matches exactly what FlightMap.tsx calls
// (on/off/addSource/addLayer/getSource/setLayoutProperty/fitBounds/jumpTo/easeTo/zoom
// in/out/remove, plus the dragPan/keyboard/scrollZoom/touchZoomRotate/doubleClickZoom
// handler objects mapInteraction's effect drives), so the component can mount for real in
// jsdom and every branch of its effects can be exercised and asserted on. The remaining
// maplibre-gl internals (real tile fetching, WebGL rendering, worker startup) are exactly
// the part that would need a real browser to test, and add no business logic of their own
// to verify — the fake Map's `container` is the *real* container div FlightMap renders, so
// Marker.addTo/.remove faithfully reflect real DOM attachment (`.isConnected`), matching
// production behavior for the branches that check it.
//
// The module-level `liveCameraState`/`workerReady` singletons in FlightMap.tsx are meant to
// survive a real remount (that's their whole purpose - see the file's own comment) but that
// makes them leak between *tests* in this file unless each test gets a fresh module
// instance. `vi.resetModules()` + a dynamic import per test gives every test its own fresh
// copy of both, and a fresh instance of this maplibre-gl mock (whose factory re-runs on
// every fresh import), so no test's map interactions can affect another's.
vi.mock('maplibre-gl', () => {
  class FakeSource {
    setData = vi.fn()
  }

  class FakeLngLatBounds {
    constructor(
      public sw: unknown,
      public ne: unknown
    ) {}
    extend(): this {
      return this
    }
  }

  const markerInstances: FakeMarker[] = []

  class FakeMarker {
    private el: HTMLElement
    constructor(opts: { element: HTMLElement }) {
      this.el = opts.element
      markerInstances.push(this)
    }
    setLngLat = vi.fn()
    setRotation = vi.fn()
    getElement(): HTMLElement {
      return this.el
    }
    addTo = vi.fn((map: FakeMap): this => {
      map.container.appendChild(this.el)
      return this
    })
    remove(): this {
      this.el.remove()
      return this
    }
  }

  const instances: FakeMap[] = []

  class FakeMap {
    container: HTMLElement
    style: string
    center: unknown
    zoom: number
    handlers: Record<string, ((e?: { originalEvent?: unknown }) => void)[]> = {}
    sources: Record<string, FakeSource> = {}
    layers: Record<string, { paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }> = {}
    dragPan = { enable: vi.fn(), disable: vi.fn() }
    keyboard = { enable: vi.fn(), disable: vi.fn(), disableRotation: vi.fn() }
    // .disable() before .enable() forces MapLibre's own handlers to actually re-apply
    // options that would otherwise no-op while already enabled (map-controls.md,
    // 2026-09-13 live-verification entry) — both real methods, not just .enable(), so the
    // fake must expose both.
    scrollZoom = { enable: vi.fn(), disable: vi.fn() }
    touchZoomRotate = { enable: vi.fn(), disable: vi.fn(), disableRotation: vi.fn() }
    doubleClickZoom = { enable: vi.fn(), disable: vi.fn() }
    fitBounds = vi.fn()
    jumpTo = vi.fn()
    easeTo = vi.fn()
    zoomIn = vi.fn()
    zoomOut = vi.fn()
    remove = vi.fn()
    setLayoutProperty = vi.fn()
    setFilter = vi.fn((id: string, filter: unknown) => {
      if (this.layers[id]) this.layers[id]!.filter = filter
    })
    controls: unknown[] = []
    addControl = vi.fn((control: unknown) => {
      this.controls.push(control)
    })
    removeControl = vi.fn((control: unknown) => {
      this.controls = this.controls.filter((c) => c !== control)
    })
    getLayer(id: string): unknown {
      return this.layers[id]
    }
    // The hosted base style's own layers (map-labels.ts reads these on every style.load).
    styleLayers: unknown[] = []
    getStyle = vi.fn(() => ({ layers: this.styleLayers }))
    setLayerZoomRange = vi.fn()

    constructor(options: { container: HTMLElement; style: string; center: unknown; zoom: number }) {
      this.container = options.container
      this.style = options.style
      this.center = options.center
      this.zoom = options.zoom
      instances.push(this)
    }
    on(event: string, cb: () => void): void {
      ;(this.handlers[event] ??= []).push(cb)
    }
    once = vi.fn((event: string, cb: () => void): void => {
      ;(this.handlers[event] ??= []).push(cb)
    })
    off(): void {}
    addSource(id: string): void {
      this.sources[id] = new FakeSource()
    }
    addLayer(def: { id: string; paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }): void {
      this.layers[def.id] = def
    }
    getSource(id: string): FakeSource | undefined {
      return this.sources[id]
    }
    getCenter(): { toArray: () => [number, number] } {
      return { toArray: () => [0, 0] }
    }
    getZoom(): number {
      return this.zoom
    }
    fireStyleLoad(): void {
      this.handlers['style.load']?.forEach((cb) => cb())
    }
  }

  return {
    Map: FakeMap,
    Marker: FakeMarker,
    LngLatBounds: FakeLngLatBounds,
    GeoJSONSource: class {},
    ScaleControl: class {
      constructor(public opts?: { unit?: string }) {}
    },
    setWorkerUrl: vi.fn(),
    __instances: instances,
    __markerInstances: markerInstances
  }
})

const ROUTE_SOURCE_ID = 'planned-route'
const ROUTE_APPROXIMATE_LAYER_ID = 'planned-route-approximate'
const TRAIL_SOURCE_ID = 'breadcrumb-trail'
const TRAIL_TIP_SOURCE_ID = 'breadcrumb-trail-tip'
const WAYPOINT_SOURCE_ID = 'planned-waypoints'
// fitBoundsTo's zoom for a lone coordinate.
const SINGLE_POINT_ZOOM = 12
const FOLLOW_ZOOM_GROUND = 15
// point()'s default 1,000 m is below 10,000 ft: the lowest airborne band (followZoom.ts).
const FOLLOW_ZOOM_LOW = 11

function point(overrides: Partial<TrackPoint> = {}): TrackPoint {
  return {
    id: 1,
    flightId: 1,
    tsUtc: '2026-01-01T00:00:00.000Z',
    latitude: 51,
    longitude: -0.5,
    altitudeM: 1000,
    pressureAltitudeM: null,
    altitudeAglM: 1000,
    indicatedAirspeedMs: 100,
    machSpeed: 0.3,
    groundSpeedMs: 110,
    verticalSpeedMs: 0,
    headingTrueDeg: 90,
    pitchDeg: 0,
    bankDeg: 0,
    phase: 'cruise',
    onGround: false,
    fuelKg: 1000,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    resumeSegment: 0,
    simRate: 1,
    excludedReason: null,
    ...overrides
  }
}

const WAYPOINT: Waypoint = { ident: 'ABC', lon: -0.5, lat: 51, altitudeFt: 5000, segment: 'enroute' }

// Fresh module graph per test (see the vi.mock comment above) — dynamic import both the
// component and the mocked maplibre-gl module so every test gets its own liveCameraState/
// workerReady singletons and its own __instances array.
async function loadFlightMap(): Promise<{
  FlightMap: typeof import('./FlightMap').FlightMap
  instances: FakeMapInstance[]
  markerInstances: FakeMarkerInstance[]
}> {
  // Fresh module graph every call (not just every test) — some tests call renderReady more
  // than once to compare two independent mounts (e.g. light vs dark theme), and each of
  // those needs its own liveCameraState/workerReady singletons.
  vi.resetModules()
  const mod = await import('./FlightMap')
  const maplibre = (await import('maplibre-gl')) as unknown as {
    __instances: FakeMapInstance[]
    __markerInstances: FakeMarkerInstance[]
  }
  // vi.resetModules() does not re-invoke this vi.mock factory in practice (confirmed live:
  // without this, __instances keeps accumulating every FakeMap ever constructed across the
  // whole file, not just this call) — clear it explicitly rather than relying on a fresh
  // array, so `instances` always starts empty for this call regardless.
  maplibre.__instances.length = 0
  maplibre.__markerInstances.length = 0
  return {
    FlightMap: mod.FlightMap,
    instances: maplibre.__instances,
    markerInstances: maplibre.__markerInstances
  }
}

/** Renders FlightMap, waits for the (mocked) map to be constructed, then fires
 *  'style.load' — the point at which the real component adds every source/layer and flips
 *  mapReady, matching maplibre-gl's own event (see FlightMap.tsx's comment on why
 *  'style.load' rather than 'load' is used). */
async function renderReady(
  props: FlightMapProps
): ReturnType<typeof loadFlightMap> extends Promise<infer T>
  ? Promise<T & { map: FakeMapInstance; rerender: (props: FlightMapProps) => void }>
  : never {
  const { FlightMap, instances, markerInstances } = await loadFlightMap()
  const { rerender } = render(<FlightMap {...props} />)
  await waitFor(() => expect(instances.length).toBe(1))
  const map = instances[0]
  await act(async () => {
    map.fireStyleLoad()
  })
  return {
    FlightMap,
    instances,
    markerInstances,
    map,
    rerender: (next: FlightMapProps) => rerender(<FlightMap {...next} />)
  } as never
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob()) } as unknown as Response)
  )
  // The real animation loop (FlightMap.tsx's live-mode marker interpolation) schedules
  // requestAnimationFrame recursively until `t` reaches 1 — jsdom has no real frame clock,
  // so a `now` far in the future collapses that to exactly one synchronous call with t
  // already saturated at 1, exercising the step function's body without an infinite loop
  // or needing to fake a real animation timeline.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    cb(performance.now() + 1_000_000)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:mock')
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('dark')
})

describe('FlightMap', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders its map controls and telemetry readout in the active i18next language, not a hardcoded English string', async () => {
    await i18n.changeLanguage('de')
    await renderReady({ route: [], trackPoints: [], live: true, telemetry: null })
    expect(screen.getByRole('button', { name: 'Zentrierung auf Flugzeug stoppen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Vergrößern' })).toBeInTheDocument()
    expect(screen.getByText(/Geschwindigkeit: k\. A\./)).toBeInTheDocument()
  })

  it('constructs the map once the worker is ready and adds every source/layer on style.load', async () => {
    const { map } = await renderReady({ route: [], trackPoints: [], live: true })
    expect(Object.keys(map.sources)).toEqual(
      expect.arrayContaining([ROUTE_SOURCE_ID, TRAIL_SOURCE_ID, TRAIL_TIP_SOURCE_ID, WAYPOINT_SOURCE_ID])
    )
    expect(Object.keys(map.layers)).toEqual(
      expect.arrayContaining([
        ROUTE_SOURCE_ID,
        ROUTE_APPROXIMATE_LAYER_ID,
        TRAIL_SOURCE_ID,
        TRAIL_TIP_SOURCE_ID,
        `${WAYPOINT_SOURCE_ID}-circle`,
        `${WAYPOINT_SOURCE_ID}-label`,
        'aeroway-taxiway-label'
      ])
    )
  })

  it('registers a moveend listener only in live mode, to persist camera state across remounts', async () => {
    const live = await renderReady({ route: [], trackPoints: [], live: true })
    expect(live.map.handlers['moveend']?.length ?? 0).toBe(1)

    const notLive = await renderReady({ route: [], trackPoints: [], live: false })
    expect(notLive.map.handlers['moveend'] ?? []).toHaveLength(0)
  })

  it('records camera state on moveend, and keeps a zoom the user chose (no forced FOLLOW_ZOOM) for the first live track point', async () => {
    const live = await renderReady({ route: [], trackPoints: [], live: true })
    // A wheel/pinch zoom (originalEvent set), then the moveend that records the camera.
    live.map.handlers['zoomend']![0]!({ originalEvent: {} })
    expect(() => live.map.handlers['moveend']![0]!()).not.toThrow()

    // The first live track point arriving now sees the user's zoom (set just above, in this
    // same module instance) and keeps it, only re-centring.
    await act(async () => {
      live.rerender({ route: [], trackPoints: [point()], live: true })
    })
    expect(live.map.jumpTo).toHaveBeenCalledWith({ center: [point().longitude, point().latitude] })
  })

  describe('Track map memory and zoom (Callum, 2026-09-30)', () => {
    const ROUTE: [number, number][] = [
      [113.9, 22.3],
      [-112.0, 33.4]
    ]

    /** Renders, unmounts, and renders again with the same module instance — what switching
     *  away from Track and back actually does (App.tsx only mounts the active tab). */
    async function mountTwice(
      first: FlightMapProps,
      between: (map: FakeMapInstance) => void,
      second: FlightMapProps
    ): Promise<{ firstMap: FakeMapInstance; secondMap: FakeMapInstance }> {
      const { FlightMap, instances } = await loadFlightMap()
      const view = render(<FlightMap {...first} />)
      await waitFor(() => expect(instances.length).toBe(1))
      const firstMap = instances[0]!
      await act(async () => firstMap.fireStyleLoad())
      between(firstMap)
      view.unmount()
      render(<FlightMap {...second} />)
      await waitFor(() => expect(instances.length).toBe(2))
      const secondMap = instances[1]!
      await act(async () => secondMap.fireStyleLoad())
      return { firstMap, secondMap }
    }

    it('coming back to Track keeps the remembered view instead of re-fitting the same route', async () => {
      const props = { route: ROUTE, trackPoints: [], live: true }
      const { firstMap, secondMap } = await mountTwice(props, (map) => map.handlers['moveend']![0]!(), props)
      expect(firstMap.fitBounds).toHaveBeenCalledTimes(1)
      expect(secondMap.fitBounds).not.toHaveBeenCalled()
    })

    it('a genuinely new route is still fitted', async () => {
      const { secondMap } = await mountTwice(
        { route: ROUTE, trackPoints: [], live: true },
        (map) => map.handlers['moveend']![0]!(),
        { route: [ROUTE[0]!, [151.2, -33.9]], trackPoints: [], live: true }
      )
      expect(secondMap.fitBounds).toHaveBeenCalledTimes(1)
    })

    it('while following an aircraft, frames the aircraft rather than the whole route', async () => {
      const { map } = await renderReady({ route: ROUTE, trackPoints: [point({ onGround: true })], live: true })
      expect(map.fitBounds).not.toHaveBeenCalled()
      expect(map.jumpTo).toHaveBeenCalledWith({ center: [-0.5, 51], zoom: FOLLOW_ZOOM_GROUND })
    })

    it("doesn't remember a zoom the map picked itself — the aircraft is framed at ground zoom, not the route overview (2026-10-02)", async () => {
      const { secondMap } = await mountTwice(
        { route: ROUTE, trackPoints: [], live: true },
        (map) => map.handlers['moveend']![0]!(), // the route fit's own moveend, no user zoom
        { route: ROUTE, trackPoints: [point({ onGround: true })], live: true }
      )
      expect(secondMap.jumpTo).toHaveBeenCalledWith({ center: [-0.5, 51], zoom: FOLLOW_ZOOM_GROUND })
    })

    it('keeps a zoom chosen with the zoom buttons across a tab switch', async () => {
      const user = userEvent.setup()
      const { FlightMap, instances } = await loadFlightMap()
      const view = render(<FlightMap route={[]} trackPoints={[]} live />)
      await waitFor(() => expect(instances.length).toBe(1))
      await act(async () => instances[0]!.fireStyleLoad())
      await user.click(screen.getByRole('button', { name: 'Zoom in' }))
      instances[0]!.handlers['moveend']![0]!()
      view.unmount()

      render(<FlightMap route={[]} trackPoints={[point({ onGround: true })]} live />)
      await waitFor(() => expect(instances.length).toBe(2))
      await act(async () => instances[1]!.fireStyleLoad())
      expect(instances[1]!.jumpTo).toHaveBeenCalledWith({ center: [-0.5, 51] })
    })

    it("doesn't frame the route while the flight's track is still loading — no flash before jumping to the aircraft (2026-10-02)", async () => {
      const { map, rerender } = await renderReady({ route: ROUTE, trackPoints: [], live: true, trackLoading: true })
      expect(map.fitBounds).not.toHaveBeenCalled()

      await act(async () => {
        rerender({ route: ROUTE, trackPoints: [point({ onGround: true })], live: true, trackLoading: false })
      })
      expect(map.fitBounds).not.toHaveBeenCalled()
      expect(map.jumpTo).toHaveBeenCalledWith({ center: [-0.5, 51], zoom: FOLLOW_ZOOM_GROUND })
    })

    it('frames the route once loading finds no flight to follow', async () => {
      const { map, rerender } = await renderReady({ route: ROUTE, trackPoints: [], live: true, trackLoading: true })
      await act(async () => {
        rerender({ route: ROUTE, trackPoints: [], live: true, trackLoading: false })
      })
      expect(map.fitBounds).toHaveBeenCalledTimes(1)
    })

    it("saves the camera where it actually is when leaving Track mid-pan, not the last finished move (2026-10-02)", async () => {
    const { secondMap } = await mountTwice(
      { route: ROUTE, trackPoints: [point()], live: true },
      (map) => {
        map.handlers['moveend']![0]!() // a finished move at [0, 0]…
        // …then an easeTo still in flight when the user switches tab.
        map.getCenter = () => ({ toArray: () => [113.5, 22.1] })
      },
      { route: ROUTE, trackPoints: [], live: true, trackLoading: true }
    )
    expect(secondMap.center).toEqual([113.5, 22.1])
  })

  describe('hidden until the aircraft is framed, so Track never shows a stale view then jumps (2026-10-02)', () => {
    const container = (map: FakeMapInstance): HTMLElement => map.container

    it('stays hidden while the flight loads, and appears once the tiles at the aircraft are drawn', async () => {
      const { map, rerender } = await renderReady({ route: ROUTE, trackPoints: [], live: true, trackLoading: true })
      expect(container(map)).toHaveAttribute('data-framed', 'false')
      expect(container(map)).toHaveClass('opacity-0')

      await act(async () => {
        rerender({ route: ROUTE, trackPoints: [point()], live: true, trackLoading: false })
      })
      expect(map.jumpTo).toHaveBeenCalledWith({ center: [-0.5, 51], zoom: FOLLOW_ZOOM_LOW })
      expect(container(map)).toHaveAttribute('data-framed', 'false') // tiles still loading
      await act(async () => map.handlers['idle']!.forEach((cb) => cb()))
      expect(container(map)).toHaveAttribute('data-framed', 'true')
      expect(container(map)).not.toHaveClass('opacity-0')
    })

    it('shows straight away with no flight to follow, with follow off, and on the Logbook map', async () => {
      const noFlight = await renderReady({ route: ROUTE, trackPoints: [], live: true })
      expect(container(noFlight.map)).toHaveAttribute('data-framed', 'true')
      const logbook = await renderReady({ route: ROUTE, trackPoints: [point()], live: false })
      expect(container(logbook.map)).toHaveAttribute('data-framed', 'true')
    })

    it('never stays hidden for more than a moment if the aircraft never gets framed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const { map } = await renderReady({ route: ROUTE, trackPoints: [], live: true, trackLoading: true })
        expect(container(map)).toHaveAttribute('data-framed', 'false')
        await act(async () => {
          vi.advanceTimersByTime(1500)
        })
        expect(container(map)).toHaveAttribute('data-framed', 'true')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('remembers "Center on aircraft" being switched off across a tab switch', async () => {
      const user = userEvent.setup()
      const { FlightMap, instances } = await loadFlightMap()
      const view = render(<FlightMap route={[]} trackPoints={[]} live />)
      await waitFor(() => expect(instances.length).toBe(1))
      await act(async () => instances[0]!.fireStyleLoad())
      await user.click(screen.getByRole('button', { name: 'Stop centering on aircraft' }))
      view.unmount()
      render(<FlightMap route={[]} trackPoints={[]} live />)
      expect(await screen.findByRole('button', { name: 'Center on aircraft' })).toHaveAttribute('aria-pressed', 'false')
    })

    it('steps the zoom out by altitude band in the climb and back in on descent, once per band (2026-10-02)', async () => {
    // Real YBBN-VHHH levels: climb-out, through 10,000 ft, FL150, initial cruise FL380.
    const at = (id: number, ft: number): TrackPoint => point({ id, altitudeM: ft * 0.3048, pressureAltitudeM: ft * 0.3048 })
    const climb = [at(1, 3_000)]
    const { map, rerender } = await renderReady({ route: [], trackPoints: climb, live: true })
    map.easeTo.mockClear()
    const zoomEases = (): unknown[] => map.easeTo.mock.calls.map((c) => c[0]).filter((arg) => 'zoom' in (arg as object))

    async function fly(ft: number): Promise<void> {
      climb.push(at(climb.length + 1, ft))
      await act(async () => {
        rerender({ route: [], trackPoints: [...climb], live: true })
      })
    }

    await fly(8_000)
    await fly(10_300) // within 500 ft of the band edge: no change yet
    expect(zoomEases()).toEqual([])
    await fly(11_000)
    expect(zoomEases()).toEqual([{ zoom: 10, duration: 1000 }])
    await fly(15_000) // same band: a zoom the user set here is left alone
    await fly(38_000)
    expect(zoomEases()).toEqual([
      { zoom: 10, duration: 1000 },
      { zoom: 9, duration: 1000 }
    ])
    await fly(24_000) // descending below FL250 by more than the margin
    expect(zoomEases().at(-1)).toEqual({ zoom: 10, duration: 1000 })
  })

  it('zooms out at takeoff and back in at touchdown while following', async () => {
      const { map, rerender } = await renderReady({ route: [], trackPoints: [point({ id: 1, onGround: true })], live: true })
      map.easeTo.mockClear()

      await act(async () => {
        rerender({ route: [], trackPoints: [point({ id: 1, onGround: true }), point({ id: 2, onGround: false })], live: true })
      })
      expect(map.easeTo).toHaveBeenCalledWith({ zoom: FOLLOW_ZOOM_LOW, duration: 1000 })

      map.easeTo.mockClear()
      await act(async () => {
        rerender({
          route: [],
          trackPoints: [point({ id: 1, onGround: true }), point({ id: 2, onGround: false }), point({ id: 3, onGround: true })],
          live: true
        })
      })
      expect(map.easeTo).toHaveBeenCalledWith({ zoom: FOLLOW_ZOOM_GROUND, duration: 1000 })
    })
  })

  it('uses the light style by default and the dark style when the document is in dark mode', async () => {
    const light = await renderReady({ route: [], trackPoints: [], live: false })
    expect(light.map.style).toBe('https://tiles.openfreemap.org/styles/positron')

    document.documentElement.classList.add('dark')
    const dark = await renderReady({ route: [], trackPoints: [], live: false })
    expect(dark.map.style).toBe('https://tiles.openfreemap.org/styles/dark')
    // Waypoint/taxiway label colors are picked once, alongside the style, from the same
    // dark flag — confirms the real-complaint fix (dark-on-dark label halos) is wired up.
    expect(dark.map.layers[`${WAYPOINT_SOURCE_ID}-label`].paint?.['text-color']).toBe('#c7d3e0')
    expect(dark.map.layers['aeroway-taxiway-label'].paint?.['text-color']).toBe('#e0b24d')
  })

  describe('map language and declutter (docs/plans/map-language-and-declutter.md)', () => {
    const TWO_LINE = [
      'case',
      ['has', 'name:nonlatin'],
      ['concat', ['get', 'name:latin'], '\n', ['get', 'name:nonlatin']],
      ['get', 'name']
    ]
    const STYLE_LAYERS = [
      {
        id: 'label_village',
        type: 'symbol',
        'source-layer': 'place',
        minzoom: 9,
        filter: ['==', ['get', 'class'], 'village'],
        layout: { 'text-field': TWO_LINE }
      },
      {
        id: 'label_city',
        type: 'symbol',
        'source-layer': 'place',
        minzoom: 3,
        filter: ['==', ['get', 'class'], 'city'],
        layout: { 'text-field': TWO_LINE }
      }
    ]

    /** Renders, seeds the base style's layers, then fires style.load like maplibre would. */
    async function renderWithStyle(
      props: Partial<FlightMapProps>
    ): ReturnType<typeof loadFlightMap> extends Promise<infer T>
      ? Promise<T & { map: FakeMapInstance; rerender: (next: FlightMapProps) => void }>
      : never {
      const { FlightMap, instances, markerInstances } = await loadFlightMap()
      const base: FlightMapProps = { route: [], trackPoints: [], live: false, ...props }
      const { rerender } = render(<FlightMap {...base} />)
      await waitFor(() => expect(instances.length).toBe(1))
      const map = instances[0]
      map.styleLayers = STYLE_LAYERS
      await act(async () => {
        map.fireStyleLoad()
      })
      return {
        FlightMap,
        instances,
        markerInstances,
        map,
        rerender: (next: FlightMapProps) => rerender(<FlightMap {...next} />)
      } as never
    }

    const textFieldCalls = (map: FakeMapInstance): unknown[][] =>
      map.setLayoutProperty.mock.calls.filter((c) => c[1] === 'text-field')

    it('collapses the two-line labels to English by default and pushes village labels to a later zoom', async () => {
      const { map } = await renderWithStyle({})

      const rewritten = textFieldCalls(map).map((c) => c[0])
      expect(rewritten).toEqual(expect.arrayContaining(['label_village', 'label_city']))
      expect(textFieldCalls(map)[0]?.[2]).toEqual([
        'coalesce',
        ['get', 'name:en'],
        ['get', 'name_en'],
        ['get', 'name:latin'],
        ['get', 'name']
      ])
      // village 9 -> 10, keeping the style's own maxzoom (unset -> 24); the city is untouched.
      expect(map.setLayerZoomRange).toHaveBeenCalledWith('label_village', 10, 24)
      expect(map.setLayerZoomRange).not.toHaveBeenCalledWith(
        'label_city',
        expect.anything(),
        expect.anything()
      )
    })

    it('uses the chosen language, and re-applies on every style load (a theme switch drops the changes)', async () => {
      const { map } = await renderWithStyle({ mapLanguage: 'de' })
      expect(textFieldCalls(map)[0]?.[2]).toEqual([
        'coalesce',
        ['get', 'name:de'],
        ['get', 'name:latin'],
        ['get', 'name']
      ])

      const before = textFieldCalls(map).length
      await act(async () => {
        map.fireStyleLoad()
      })
      expect(textFieldCalls(map).length).toBeGreaterThan(before)
    })

    it('follows a language change while the map is open', async () => {
      const { map, rerender } = await renderWithStyle({ mapLanguage: 'en' })
      map.setLayoutProperty.mockClear()

      rerender({ route: [], trackPoints: [], live: false, mapLanguage: 'fr' })

      await waitFor(() =>
        expect(textFieldCalls(map)[0]?.[2]).toEqual([
          'coalesce',
          ['get', 'name:fr'],
          ['get', 'name:latin'],
          ['get', 'name']
        ])
      )
    })

    it('leaves the map alone, without throwing, when the style cannot be read', async () => {
      const { FlightMap, instances } = await loadFlightMap()
      render(<FlightMap route={[]} trackPoints={[]} live={false} />)
      await waitFor(() => expect(instances.length).toBe(1))
      instances[0].getStyle.mockImplementation(() => {
        throw new Error('style not ready')
      })
      await act(async () => {
        instances[0].fireStyleLoad()
      })
      expect(textFieldCalls(instances[0])).toEqual([])
      // Its own layers still got added — the failure was contained.
      expect(instances[0].layers[ROUTE_SOURCE_ID]).toBeDefined()
    })
  })

  describe('VFR overlay (docs/plans/map-language-and-declutter.md, Part C)', () => {
    const AIRFIELDS = [
      { icao: 'EGLL', name: 'Heathrow', type: 'large_airport', latitude: 51.4706, longitude: -0.4619 },
      { icao: 'EGKB', name: 'Biggin Hill', type: 'small_airport', latitude: 51.3308, longitude: 0.0325 },
      { icao: 'EGLW', name: 'London Heliport', type: 'heliport', latitude: 51.4697, longitude: -0.1791 }
    ]
    const TELEMETRY = { latitude: 51.4787, longitude: -0.2956 } as SimTelemetry

    // A factory, not a promise: a rejected promise created up front would be "unhandled"
    // until the component under test attached its own handler.
    function stubWinglog(
      list: () => Promise<unknown> = () => Promise.resolve(AIRFIELDS)
    ): ReturnType<typeof vi.fn> {
      const airportListAirfields = vi.fn().mockImplementation(list)
      ;(window as unknown as { winglog: unknown }).winglog = { airportListAirfields }
      return airportListAirfields
    }

    const VFR_LAYERS = [
      'vfr-airfields-major',
      'vfr-airfields-major-label',
      'vfr-airfields-small',
      'vfr-airfields-small-label',
      'vfr-airfields-minor',
      'vfr-airfields-minor-label',
      'vfr-range-rings-line',
      'vfr-range-rings-label',
      'vfr-recent-trail'
    ]

    const toggleButton = (): HTMLElement => screen.getByRole('button', { name: /VFR overlay/ })

    it('is off by default: nothing loaded, no layers, no scale bar', async () => {
      const list = stubWinglog()
      const { map } = await renderReady({ route: [], trackPoints: [], live: true })

      expect(toggleButton()).toHaveAttribute('aria-pressed', 'false')
      expect(list).not.toHaveBeenCalled()
      expect(map.layers['vfr-airfields-major']).toBeUndefined()
      expect(map.controls).toEqual([])
    })

    it("offers no overlay on a finished flight's static map", async () => {
      stubWinglog()
      await renderReady({ route: [], trackPoints: [], live: false })
      expect(screen.queryByRole('button', { name: /VFR overlay/ })).not.toBeInTheDocument()
    })

    it('switching it on loads the airfields once and adds every layer, under the route, with a nautical scale bar', async () => {
      const list = stubWinglog()
      const user = userEvent.setup()
      const { map } = await renderReady({
        route: [],
        trackPoints: [point()],
        live: true,
        telemetry: TELEMETRY
      })

      await user.click(toggleButton())

      await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
      for (const id of VFR_LAYERS) expect(map.layers[id], id).toBeDefined()
      await waitFor(() => expect(map.sources['vfr-airfields'].setData).toHaveBeenCalled())
      const airfieldData = map.sources['vfr-airfields'].setData.mock.calls.at(-1)?.[0] as {
        features: unknown[]
      }
      expect(airfieldData.features).toHaveLength(3)
      expect(map.addControl).toHaveBeenCalledTimes(1)
      expect(map.controls[0]?.opts).toEqual({ unit: 'nautical' })
      expect(toggleButton()).toHaveAttribute('aria-pressed', 'true')
    })

    it('only shows small strips and heliports at closer zooms than airports', async () => {
      stubWinglog()
      const user = userEvent.setup()
      const { map } = await renderReady({ route: [], trackPoints: [point()], live: true })
      await user.click(toggleButton())
      await waitFor(() => expect(map.layers['vfr-airfields-minor']).toBeDefined())

      const minzoom = (id: string): number => (map.layers[id] as unknown as { minzoom: number }).minzoom
      expect(minzoom('vfr-airfields-major')).toBeLessThan(minzoom('vfr-airfields-small'))
      expect(minzoom('vfr-airfields-small')).toBeLessThan(minzoom('vfr-airfields-minor'))
      expect(minzoom('vfr-airfields-major')).toBeLessThan(minzoom('vfr-airfields-major-label'))
    })

    it('draws three range rings and the last-10-minutes trail around the aircraft', async () => {
      stubWinglog()
      const user = userEvent.setup()
      const points = [0, 4, 8, 12, 16].map((m, i) =>
        point({
          id: i + 1,
          tsUtc: new Date(Date.UTC(2026, 0, 1, 12, m)).toISOString(),
          longitude: -0.5 + i * 0.01
        })
      )
      const { map } = await renderReady({ route: [], trackPoints: points, live: true, telemetry: TELEMETRY })
      await user.click(toggleButton())

      await waitFor(() => expect(map.sources['vfr-range-rings'].setData).toHaveBeenCalled())
      const rings = map.sources['vfr-range-rings'].setData.mock.calls.at(-1)?.[0] as {
        features: { geometry: { type: string } }[]
      }
      expect(rings.features.filter((f) => f.geometry.type === 'LineString')).toHaveLength(3)
      const trail = map.sources['vfr-recent-trail'].setData.mock.calls.at(-1)?.[0] as {
        geometry: { coordinates: unknown[][] }
      }
      // Newest is minute 16 -> only minutes 8, 12 and 16 fall inside the 10-minute window.
      expect(trail.geometry.coordinates[0]).toHaveLength(3)
    })

    it('shows the nearest landable airfield (not a heliport) with distance and bearing', async () => {
      stubWinglog()
      const user = userEvent.setup()
      await renderReady({ route: [], trackPoints: [point()], live: true, telemetry: TELEMETRY })

      expect(screen.queryByLabelText('Nearest airfield')).not.toBeInTheDocument()
      await user.click(toggleButton())

      const chip = await screen.findByLabelText('Nearest airfield')
      expect(chip.textContent).toMatch(/^Nearest: EGLL Heathrow · \d+(\.\d)? nm · 2\d\d°$/)
    })

    it('switching it off hides the layers and removes the scale bar, keeping them for next time', async () => {
      stubWinglog()
      const user = userEvent.setup()
      const { map } = await renderReady({
        route: [],
        trackPoints: [point()],
        live: true,
        telemetry: TELEMETRY
      })
      await user.click(toggleButton())
      await waitFor(() => expect(map.controls).toHaveLength(1))
      map.setLayoutProperty.mockClear()

      await user.click(toggleButton())

      for (const id of VFR_LAYERS)
        expect(map.setLayoutProperty).toHaveBeenCalledWith(id, 'visibility', 'none')
      expect(map.removeControl).toHaveBeenCalledTimes(1)
      expect(map.controls).toEqual([])
      expect(screen.queryByLabelText('Nearest airfield')).not.toBeInTheDocument()
    })

    it('does not re-request the airfields when toggled off and on again', async () => {
      const list = stubWinglog()
      const user = userEvent.setup()
      await renderReady({ route: [], trackPoints: [point()], live: true, telemetry: TELEMETRY })
      await user.click(toggleButton())
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
      await user.click(toggleButton())
      await user.click(toggleButton())
      expect(list).toHaveBeenCalledTimes(1)
    })

    it('remembers being on across a remount (leaving Track and coming back)', async () => {
      const list = stubWinglog()
      const user = userEvent.setup()
      const { FlightMap, instances, rerender } = await renderReady({
        route: [],
        trackPoints: [point()],
        live: true
      })
      await user.click(toggleButton())
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
      cleanup()

      instances.length = 0
      render(<FlightMap route={[]} trackPoints={[point()]} live />)
      await waitFor(() => expect(instances.length).toBe(1))
      await act(async () => {
        instances[0].fireStyleLoad()
      })

      expect(toggleButton()).toHaveAttribute('aria-pressed', 'true')
      await waitFor(() => expect(instances[0].layers['vfr-range-rings-line']).toBeDefined())
      // The list is cached in the renderer — no second trip over IPC.
      expect(list).toHaveBeenCalledTimes(1)
      void rerender
    })

    it('still draws rings and the scale bar when the airfield list cannot be loaded', async () => {
      stubWinglog(() => Promise.reject(new Error('ipc down')))
      const user = userEvent.setup()
      const { map } = await renderReady({
        route: [],
        trackPoints: [point()],
        live: true,
        telemetry: TELEMETRY
      })

      await user.click(toggleButton())

      await waitFor(() => expect(map.controls).toHaveLength(1))
      await waitFor(() => expect(map.sources['vfr-range-rings'].setData).toHaveBeenCalled())
      expect(screen.queryByLabelText('Nearest airfield')).not.toBeInTheDocument()
    })
  })

  describe('Taxi chart overlay (flightdeck-backend docs/plans/taxi-network-overlay.md)', () => {
    const DEP_SEGMENTS = [{ startLat: 51.338, startLon: 0.038, endLat: 51.324, endLon: 0.027, name: null }]
    const ARR_SEGMENTS = [{ startLat: 22.31, startLon: 113.91, endLat: 22.32, endLon: 113.92, name: 'C' }]

    function stubWinglog(cached: Record<string, boolean> = {}): {
      hasTaxiNetwork: ReturnType<typeof vi.fn>
      refreshTaxiNetwork: ReturnType<typeof vi.fn>
      getTaxiNetwork: ReturnType<typeof vi.fn>
      onBeyondAtcTranscript: ReturnType<typeof vi.fn>
    } {
      const segmentsByIcao: Record<string, unknown> = { EGKB: DEP_SEGMENTS, VHHH: ARR_SEGMENTS }
      const hasTaxiNetwork = vi.fn().mockImplementation((icao: string) => Promise.resolve(cached[icao] ?? false))
      const refreshTaxiNetwork = vi.fn().mockResolvedValue(undefined)
      const getTaxiNetwork = vi.fn().mockImplementation((icao: string) => Promise.resolve(segmentsByIcao[icao] ?? []))
      // useTaxiRouteHighlight.ts subscribes once the chart is switched on — a no-op
      // unsubscribe is enough for every test in this block that doesn't care about it
      // (the "ATC-driven route highlight" block below overrides this to actually push).
      const onBeyondAtcTranscript = vi.fn(() => () => {})
      ;(window as unknown as { winglog: unknown }).winglog = {
        navdataHasTaxiNetwork: hasTaxiNetwork,
        navdataRefreshTaxiNetwork: refreshTaxiNetwork,
        navdataGetTaxiNetwork: getTaxiNetwork,
        beyondAtcGetTranscript: vi.fn().mockResolvedValue([]),
        onBeyondAtcTranscript
      }
      return { hasTaxiNetwork, refreshTaxiNetwork, getTaxiNetwork, onBeyondAtcTranscript }
    }

    const toggleButton = (): HTMLElement => screen.getByRole('button', { name: /taxi chart/i })

    it('is off by default: nothing fetched, no layer', async () => {
      const { hasTaxiNetwork } = stubWinglog()
      const { map } = await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })

      expect(toggleButton()).toHaveAttribute('aria-pressed', 'false')
      expect(hasTaxiNetwork).not.toHaveBeenCalled()
      expect(map.layers['taxi-chart-line']).toBeUndefined()
    })

    it('is offered even on a finished flight\'s static map, unlike the VFR overlay', async () => {
      stubWinglog()
      await renderReady({ route: [], trackPoints: [], live: false, depIcao: 'EGKB' })
      expect(toggleButton()).toBeInTheDocument()
    })

    it('switching it on refreshes an uncached airport, then loads and draws its segments', async () => {
      const { hasTaxiNetwork, refreshTaxiNetwork, getTaxiNetwork } = stubWinglog()
      const user = userEvent.setup()
      const { map } = await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })

      await user.click(toggleButton())

      await waitFor(() => expect(hasTaxiNetwork).toHaveBeenCalledWith('EGKB'))
      expect(refreshTaxiNetwork).toHaveBeenCalledWith('EGKB')
      await waitFor(() => expect(getTaxiNetwork).toHaveBeenCalledWith('EGKB'))
      await waitFor(() => {
        const data = map.sources['taxi-chart']?.setData.mock.calls.at(-1)?.[0] as { features: unknown[] } | undefined
        expect(data?.features).toHaveLength(1)
      })
      expect(toggleButton()).toHaveAttribute('aria-pressed', 'true')
    })

    it('does not refresh an already-cached airport', async () => {
      const { hasTaxiNetwork, refreshTaxiNetwork, getTaxiNetwork } = stubWinglog({ EGKB: true })
      const user = userEvent.setup()
      await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })

      await user.click(toggleButton())

      await waitFor(() => expect(getTaxiNetwork).toHaveBeenCalledWith('EGKB'))
      expect(hasTaxiNetwork).toHaveBeenCalledWith('EGKB')
      expect(refreshTaxiNetwork).not.toHaveBeenCalled()
    })

    it('loads departure and arrival independently, merging both into one chart', async () => {
      const { getTaxiNetwork } = stubWinglog({ EGKB: true, VHHH: true })
      const user = userEvent.setup()
      const { map } = await renderReady({
        route: [],
        trackPoints: [],
        live: true,
        depIcao: 'EGKB',
        arrIcao: 'VHHH'
      })

      await user.click(toggleButton())

      await waitFor(() => expect(getTaxiNetwork).toHaveBeenCalledWith('EGKB'))
      await waitFor(() => expect(getTaxiNetwork).toHaveBeenCalledWith('VHHH'))
      await waitFor(() => {
        const data = map.sources['taxi-chart']?.setData.mock.calls.at(-1)?.[0] as { features: unknown[] } | undefined
        expect(data?.features).toHaveLength(2)
      })
    })

    it('shows a loading message for the airport currently being fetched', async () => {
      let resolveRefresh: (() => void) | undefined
      const hasTaxiNetwork = vi.fn().mockResolvedValue(false)
      const refreshTaxiNetwork = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveRefresh = resolve
          })
      )
      const getTaxiNetwork = vi.fn().mockResolvedValue(DEP_SEGMENTS)
      ;(window as unknown as { winglog: unknown }).winglog = {
        navdataHasTaxiNetwork: hasTaxiNetwork,
        navdataRefreshTaxiNetwork: refreshTaxiNetwork,
        navdataGetTaxiNetwork: getTaxiNetwork,
        beyondAtcGetTranscript: vi.fn().mockResolvedValue([]),
        onBeyondAtcTranscript: vi.fn(() => () => {})
      }
      const user = userEvent.setup()
      await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })

      await user.click(toggleButton())

      expect(await screen.findByText(/EGKB/)).toBeInTheDocument()
      await act(async () => {
        resolveRefresh?.()
      })
      await waitFor(() => expect(screen.queryByText(/EGKB/)).not.toBeInTheDocument())
    })

    it('switching it off hides the layer, keeping it cached for next time', async () => {
      const { getTaxiNetwork } = stubWinglog()
      const user = userEvent.setup()
      const { map } = await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })
      await user.click(toggleButton())
      await waitFor(() => expect(getTaxiNetwork).toHaveBeenCalledWith('EGKB'))
      map.setLayoutProperty.mockClear()

      await user.click(toggleButton())

      expect(map.setLayoutProperty).toHaveBeenCalledWith('taxi-chart-line', 'visibility', 'none')
    })

    it('does not re-fetch when toggled off and on again', async () => {
      const { getTaxiNetwork } = stubWinglog()
      const user = userEvent.setup()
      await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })
      await user.click(toggleButton())
      await waitFor(() => expect(getTaxiNetwork).toHaveBeenCalledTimes(1))
      await user.click(toggleButton())
      await user.click(toggleButton())
      expect(getTaxiNetwork).toHaveBeenCalledTimes(1)
    })

    it('clears the loading message and leaves the rest of the map working when the fetch fails', async () => {
      const hasTaxiNetwork = vi.fn().mockResolvedValue(false)
      const refreshTaxiNetwork = vi.fn().mockRejectedValue(new Error('sim not running'))
      const getTaxiNetwork = vi.fn().mockResolvedValue([])
      ;(window as unknown as { winglog: unknown }).winglog = {
        navdataHasTaxiNetwork: hasTaxiNetwork,
        navdataRefreshTaxiNetwork: refreshTaxiNetwork,
        navdataGetTaxiNetwork: getTaxiNetwork,
        beyondAtcGetTranscript: vi.fn().mockResolvedValue([]),
        onBeyondAtcTranscript: vi.fn(() => () => {})
      }
      const user = userEvent.setup()
      await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })

      await user.click(toggleButton())

      await waitFor(() => expect(refreshTaxiNetwork).toHaveBeenCalledWith('EGKB'))
      await waitFor(() => expect(screen.queryByText(/EGKB/)).not.toBeInTheDocument())
      expect(toggleButton()).toHaveAttribute('aria-pressed', 'true')
    })
  })

  describe('ATC-driven taxi route highlight (flightdeck-backend docs/plans/beyondatc-taxi-route-highlight.md)', () => {
    const NAMED_SEGMENTS = [
      { startLat: 51.338, startLon: 0.038, endLat: 51.324, endLon: 0.027, name: 'D' },
      { startLat: 51.34, startLon: 0.04, endLat: 51.335, endLon: 0.036, name: 'B' },
      { startLat: 51.336, startLon: 0.035, endLat: 51.33, endLon: 0.03, name: 'LINK' }
    ]

    type TranscriptEntry = { speaker: 'player' | 'atc' | 'traffic' | 'atcTraffic'; text: string; ts: number }

    function withTranscriptListener(
      segments: unknown[] = NAMED_SEGMENTS,
      initial: TranscriptEntry[] = []
    ): { push: (transcript: TranscriptEntry[]) => void } {
      let listener: ((transcript: TranscriptEntry[]) => void) | undefined
      ;(window as unknown as { winglog: unknown }).winglog = {
        navdataHasTaxiNetwork: vi.fn().mockResolvedValue(true),
        navdataRefreshTaxiNetwork: vi.fn().mockResolvedValue(undefined),
        navdataGetTaxiNetwork: vi.fn().mockResolvedValue(segments),
        beyondAtcGetTranscript: vi.fn().mockResolvedValue(initial),
        onBeyondAtcTranscript: vi.fn((l: (transcript: TranscriptEntry[]) => void) => {
          listener = l
          return () => {}
        })
      }
      return { push: (transcript) => listener?.(transcript) }
    }

    const HIGHLIGHT_LAYER_ID = 'taxi-chart-route-highlight'
    const toggleButton = (): HTMLElement => screen.getByRole('button', { name: /taxi chart/i })

    it('highlights the real taxiway names from a live taxi clearance once the chart is on', async () => {
      const { push } = withTranscriptListener()
      const user = userEvent.setup()
      const { map } = await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })
      await user.click(toggleButton())
      await waitFor(() => expect(map.sources['taxi-chart']?.setData).toHaveBeenCalled())

      push([{ speaker: 'atc', text: 'Test 230, taxi to holding point A1, runway 27R, via D, B, LINK.', ts: 1000 }])

      await waitFor(() => expect(map.setLayoutProperty).toHaveBeenCalledWith(HIGHLIGHT_LAYER_ID, 'visibility', 'visible'))
      expect(map.layers[HIGHLIGHT_LAYER_ID]?.filter).toEqual([
        'all',
        ['in', ['get', 'name'], ['literal', ['D', 'B', 'LINK']]],
        ['==', ['get', 'icao'], 'EGKB']
      ])
    })

    it("limits a clearance to its own airport — the departure's taxiway letters never light up at the arrival (real report, 2026-09-30)", async () => {
      const { push } = withTranscriptListener()
      const user = userEvent.setup()
      const { map } = await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'VHHH', arrIcao: 'KPHX' })
      await user.click(toggleButton())
      await waitFor(() => expect(map.sources['taxi-chart']?.setData).toHaveBeenCalled())

      push([{ speaker: 'atc', text: 'Hongkong Shuttle 250, taxi to holding point B10, runway 25C, via B8, B.', ts: 1000 }])
      await waitFor(() =>
        expect(map.layers[HIGHLIGHT_LAYER_ID]?.filter).toEqual([
          'all',
          ['in', ['get', 'name'], ['literal', ['B8', 'B']]],
          ['==', ['get', 'icao'], 'VHHH']
        ])
      )

      push([{ speaker: 'atc', text: 'Hongkong Shuttle 250, taxi to Stand 12 via B, C4.', ts: 2000 }])
      await waitFor(() =>
        expect(map.layers[HIGHLIGHT_LAYER_ID]?.filter).toEqual([
          'all',
          ['in', ['get', 'name'], ['literal', ['B', 'C4']]],
          ['==', ['get', 'icao'], 'KPHX']
        ])
      )
    })

    it('draws the traced route to the holding point instead of whole taxiways, when it can be traced', async () => {
      // A small real-shaped network: stand -> D -> along B -> hold-short on A1. B carries on
      // past the A1 turn, so a whole-name highlight would light up far more than the route.
      const P = {
        stand: [51.33, 0.03],
        d: [51.331, 0.031],
        b: [51.332, 0.032],
        a1: [51.333, 0.033],
        bFar: [51.34, 0.05],
        hold: [51.3335, 0.0335]
      } as const
      const seg = (a: readonly [number, number], b: readonly [number, number], name: string | null, endHoldShort = false): unknown => ({
        startLat: a[0],
        startLon: a[1],
        endLat: b[0],
        endLon: b[1],
        name,
        startHoldShort: false,
        endHoldShort
      })
      const { push } = withTranscriptListener([
        seg(P.stand, P.d, 'D'),
        seg(P.d, P.b, 'D'),
        seg(P.b, P.a1, 'B'),
        seg(P.a1, P.bFar, 'B'),
        seg(P.a1, P.hold, 'A1', true)
      ])
      const user = userEvent.setup()
      const { map } = await renderReady({
        route: [],
        trackPoints: [],
        live: true,
        depIcao: 'EGKB',
        telemetry: { latitude: 51.33, longitude: 0.03 } as SimTelemetry
      })
      await user.click(toggleButton())
      await waitFor(() => expect(map.sources['taxi-chart']?.setData).toHaveBeenCalled())

      push([{ speaker: 'atc', text: 'Test 230, taxi to holding point A1, runway 27R, via D, B.', ts: 1000 }])

      await waitFor(() => expect(map.setLayoutProperty).toHaveBeenCalledWith('taxi-route-trace-line', 'visibility', 'visible'))
      expect(map.sources['taxi-route-trace']?.setData).toHaveBeenLastCalledWith(
        expect.objectContaining({
          geometry: {
            type: 'LineString',
            coordinates: [
              [0.03, 51.33],
              [0.031, 51.331],
              [0.032, 51.332],
              [0.033, 51.333],
              [0.0335, 51.3335]
            ]
          }
        })
      )
      expect(map.setLayoutProperty).toHaveBeenLastCalledWith(HIGHLIGHT_LAYER_ID, 'visibility', 'none')
    })

    describe('a traced route on the real network shape', () => {
      const P = {
        stand: [51.33, 0.03],
        d: [51.331, 0.031],
        b: [51.332, 0.032],
        a1: [51.333, 0.033],
        bFar: [51.34, 0.05],
        hold: [51.3335, 0.0335]
      } as const
      const seg = (a: readonly [number, number], b: readonly [number, number], name: string | null, endHoldShort = false): unknown => ({
        startLat: a[0],
        startLon: a[1],
        endLat: b[0],
        endLon: b[1],
        name,
        startHoldShort: false,
        endHoldShort
      })
      const NETWORK = [seg(P.stand, P.d, 'D'), seg(P.d, P.b, 'D'), seg(P.b, P.a1, 'B'), seg(P.a1, P.bFar, 'B'), seg(P.a1, P.hold, 'A1', true)]
      const CLEARANCE = { speaker: 'atc' as const, text: 'Test 230, taxi to holding point A1, runway 27R, via D, B.', ts: 1000 }
      const at = (lat: number, lon: number): SimTelemetry => ({ latitude: lat, longitude: lon }) as SimTelemetry
      const lastLine = (map: FakeMapInstance): unknown =>
        (map.sources['taxi-route-trace']?.setData.mock.calls.at(-1)?.[0] as { geometry: { coordinates: unknown } }).geometry.coordinates

      it("draws a clearance given before Track was opened, without waiting for ATC's next line (YBBN, 2026-10-02)", async () => {
        withTranscriptListener(NETWORK, [CLEARANCE])
        const user = userEvent.setup()
        const { map } = await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB', telemetry: at(51.33, 0.03) })
        await user.click(toggleButton())
        await waitFor(() => expect(map.setLayoutProperty).toHaveBeenCalledWith('taxi-route-trace-line', 'visibility', 'visible'))
      })

      it('traces a clearance read before the aircraft position was known, once it arrives (ZSPD, 2026-10-02)', async () => {
        // Opening Track: the transcript comes back before Track has the active flight, so the
        // map has no position yet — then the position arrives.
        withTranscriptListener(NETWORK, [CLEARANCE])
        const user = userEvent.setup()
        const props = { route: [], trackPoints: [], live: true, depIcao: 'EGKB' }
        const { map, rerender } = await renderReady({ ...props, telemetry: null })
        await user.click(toggleButton())
        await waitFor(() => expect(map.setLayoutProperty).toHaveBeenCalledWith(HIGHLIGHT_LAYER_ID, 'visibility', 'visible'))
        expect(map.setLayoutProperty).not.toHaveBeenCalledWith('taxi-route-trace-line', 'visibility', 'visible')

        await act(async () => rerender({ ...props, telemetry: at(51.33, 0.03) }))
        await waitFor(() => expect(map.setLayoutProperty).toHaveBeenCalledWith('taxi-route-trace-line', 'visibility', 'visible'))
        expect((lastLine(map) as [number, number][]).at(-1)).toEqual([0.0335, 51.3335])
      })

      it('starts the line at the aircraft and drops the part already taxied (2026-10-02)', async () => {
        const { push } = withTranscriptListener(NETWORK)
        const user = userEvent.setup()
        const props = { route: [], trackPoints: [], live: true, depIcao: 'EGKB' }
        const { map, rerender } = await renderReady({ ...props, telemetry: at(51.33, 0.03) })
        await user.click(toggleButton())
        await waitFor(() => expect(map.sources['taxi-chart']?.setData).toHaveBeenCalled())
        push([CLEARANCE])
        await waitFor(() => expect(map.setLayoutProperty).toHaveBeenCalledWith('taxi-route-trace-line', 'visibility', 'visible'))

        // Halfway along D, a little off the centreline.
        await act(async () => rerender({ ...props, telemetry: at(51.33155, 0.03145) }))
        const line = lastLine(map) as [number, number][]
        expect(line[0]).toEqual([0.03145, 51.33155])
        expect(line[1]![0]).toBeCloseTo(0.0315, 4)
        expect(line.slice(2)).toEqual([
          [0.032, 51.332],
          [0.033, 51.333],
          [0.0335, 51.3335]
        ])
      })
    })

    it('does not subscribe to the transcript while the chart is off', async () => {
      const { push } = withTranscriptListener()
      await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })

      // Nothing to assert on `push` itself (no listener registered yet) — the real assertion
      // is that mounting with the chart off never threw calling into onBeyondAtcTranscript,
      // matching every other test in this file that never stubs it at all.
      expect(() => push([{ speaker: 'atc', text: 'Test 230, taxi to holding point A1, runway 27R, via D, B, LINK.', ts: 1000 }])).not.toThrow()
    })

    it('ignores a non-taxi ATC line', async () => {
      const { push } = withTranscriptListener()
      const user = userEvent.setup()
      const { map } = await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })
      await user.click(toggleButton())
      await waitFor(() => expect(map.sources['taxi-chart']?.setData).toHaveBeenCalled())
      map.setLayoutProperty.mockClear()

      push([{ speaker: 'atc', text: 'Test 230, contact Test Radar 134.7.', ts: 1000 }])

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(map.setLayoutProperty).not.toHaveBeenCalledWith(HIGHLIGHT_LAYER_ID, 'visibility', 'visible')
    })

    it('ignores a traffic (another aircraft) taxi clearance', async () => {
      const { push } = withTranscriptListener()
      const user = userEvent.setup()
      const { map } = await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })
      await user.click(toggleButton())
      await waitFor(() => expect(map.sources['taxi-chart']?.setData).toHaveBeenCalled())
      map.setLayoutProperty.mockClear()

      push([{ speaker: 'atcTraffic', text: 'Other 42, taxi to holding point A1, runway 27R, via D, B, LINK.', ts: 1000 }])

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(map.setLayoutProperty).not.toHaveBeenCalledWith(HIGHLIGHT_LAYER_ID, 'visibility', 'visible')
    })

    it('hides the highlight layer when the chart is switched back off', async () => {
      const { push } = withTranscriptListener()
      const user = userEvent.setup()
      const { map } = await renderReady({ route: [], trackPoints: [], live: true, depIcao: 'EGKB' })
      await user.click(toggleButton())
      await waitFor(() => expect(map.sources['taxi-chart']?.setData).toHaveBeenCalled())
      push([{ speaker: 'atc', text: 'Test 230, taxi to holding point A1, runway 27R, via D, B, LINK.', ts: 1000 }])
      await waitFor(() => expect(map.setLayoutProperty).toHaveBeenCalledWith(HIGHLIGHT_LAYER_ID, 'visibility', 'visible'))
      map.setLayoutProperty.mockClear()

      await user.click(toggleButton())

      expect(map.setLayoutProperty).toHaveBeenCalledWith(HIGHLIGHT_LAYER_ID, 'visibility', 'none')
    })
  })

  it('draws the planned route and waypoint pins once ready', async () => {
    const route: [number, number][] = [
      [-0.5, 51],
      [-1, 52]
    ]
    const { map } = await renderReady({ route, waypoints: [WAYPOINT], trackPoints: [], live: false })
    expect(map.sources[ROUTE_SOURCE_ID].setData).toHaveBeenCalledWith(
      expect.objectContaining({ geometry: { type: 'LineString', coordinates: route } })
    )
    expect(map.sources[WAYPOINT_SOURCE_ID].setData).toHaveBeenCalledWith(
      expect.objectContaining({
        features: [expect.objectContaining({ properties: { ident: 'ABC', segment: 'enroute' } })]
      })
    )
  })

  it('fits bounds to the route only in live mode, and only when there is something to fit', async () => {
    const many = await renderReady({
      route: [
        [-0.5, 51],
        [-1, 52]
      ],
      trackPoints: [],
      live: true
    })
    expect(many.map.fitBounds).toHaveBeenCalled()

    const single = await renderReady({ route: [[-0.5, 51]], trackPoints: [], live: true })
    expect(single.map.jumpTo).toHaveBeenCalledWith({ center: [-0.5, 51], zoom: SINGLE_POINT_ZOOM })

    const notLive = await renderReady({
      route: [
        [-0.5, 51],
        [-1, 52]
      ],
      trackPoints: [],
      live: false
    })
    // Not live: the route-drawing effect itself never calls fitBounds (only the live-mode
    // branch does) — but the separate static-mode trail effect always runs when not live,
    // and falls back to fitting the planned route when there's no flown trail yet
    // (FlightMap.tsx's "No flown trail to fit to yet" comment), so fitBounds still gets
    // called once overall, with the route's own coordinates.
    expect(notLive.map.fitBounds).toHaveBeenCalledTimes(1)
    // FakeLngLatBounds.extend() is a no-op, so sw/ne both stay the first coordinate — real
    // maplibre-gl would genuinely extend ne to cover every point, but this fake doesn't need
    // to model that to prove fitBoundsTo was reached with the route's own coordinates.
    expect(notLive.map.fitBounds).toHaveBeenCalledWith(
      expect.objectContaining({ sw: [-0.5, 51], ne: [-0.5, 51] }),
      { padding: 40, duration: 0 }
    )
  })

  it('toggles which of the two route layers is visible based on routeIsApproximate', async () => {
    const { map, rerender } = await renderReady({
      route: [],
      trackPoints: [],
      live: false,
      routeIsApproximate: false
    })
    expect(map.setLayoutProperty).toHaveBeenCalledWith(ROUTE_SOURCE_ID, 'visibility', 'visible')
    expect(map.setLayoutProperty).toHaveBeenCalledWith(ROUTE_APPROXIMATE_LAYER_ID, 'visibility', 'none')

    rerender({ route: [], trackPoints: [], live: false, routeIsApproximate: true })
    await waitFor(() =>
      expect(map.setLayoutProperty).toHaveBeenCalledWith(ROUTE_SOURCE_ID, 'visibility', 'none')
    )
    expect(map.setLayoutProperty).toHaveBeenCalledWith(ROUTE_APPROXIMATE_LAYER_ID, 'visibility', 'visible')
  })

  it('static mode draws the whole trail split by resume segment, positions the marker, and fits bounds', async () => {
    const points = [
      point({ id: 1, longitude: -0.5, latitude: 51, resumeSegment: 0 }),
      point({ id: 2, longitude: -0.6, latitude: 51.2, resumeSegment: 0 }),
      // A restart boundary — trailSegments must never draw a line across this gap.
      point({ id: 3, longitude: 10, latitude: 40, resumeSegment: 1, headingTrueDeg: 270 })
    ]
    const { map, rerender, markerInstances } = await renderReady({
      route: [],
      trackPoints: points,
      live: false
    })

    expect(map.sources[TRAIL_SOURCE_ID].setData).toHaveBeenCalledWith(
      expect.objectContaining({
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [-0.5, 51],
              [-0.6, 51.2]
            ],
            [[10, 40]]
          ]
        }
      })
    )
    expect(map.fitBounds).toHaveBeenCalled()
    expect(markerInstances[0].addTo).toHaveBeenCalledTimes(1)

    // Re-running this effect with the marker already attached (e.g. a prop change unrelated
    // to trackPoints) must not re-attach it a second time.
    await act(async () => {
      rerender({ route: [[-0.5, 51]], trackPoints: points, live: false })
    })
    expect(markerInstances[0].addTo).toHaveBeenCalledTimes(1)
  })

  it('static mode falls back to the planned route for fitBounds when there is no flown trail yet', async () => {
    const route: [number, number][] = [
      [-0.5, 51],
      [-1, 52]
    ]
    const { map } = await renderReady({ route, trackPoints: [], live: false })
    expect(map.fitBounds).toHaveBeenCalled()
    // No trail points at all — the marker is never touched (nothing to position it at).
    expect(map.sources[TRAIL_SOURCE_ID].setData).toHaveBeenCalledWith(
      expect.objectContaining({ geometry: { type: 'MultiLineString', coordinates: [] } })
    )
  })

  it('live mode: the first track point jumps the camera straight to it and adds the marker', async () => {
    const { map, instances } = await renderReady({ route: [], trackPoints: [point()], live: true })
    expect(map.jumpTo).toHaveBeenCalledWith({ center: [-0.5, 51], zoom: FOLLOW_ZOOM_LOW })
    // Marker.addTo appends the real marker element into the map's own real container div —
    // confirms it actually attached, the same thing the component's own `.isConnected`
    // checks rely on.
    expect(instances).toHaveLength(1)
    expect(map.container.querySelector('svg')).not.toBeNull()
  })

  it('live mode: the first track point does not move the camera when follow is already off', async () => {
    const user = userEvent.setup()
    const { map, rerender } = await renderReady({ route: [], trackPoints: [], live: true })
    await user.click(screen.getByRole('button', { name: 'Stop centering on aircraft' }))

    await act(async () => {
      rerender({ route: [], trackPoints: [point()], live: true })
    })
    expect(map.jumpTo).not.toHaveBeenCalled()
    // The marker still gets positioned regardless of follow — only the camera move is
    // conditional on it.
    expect(map.container.querySelector('svg')).not.toBeNull()
  })

  it('live mode: clears the trail and removes the marker once track points disappear', async () => {
    const { map, rerender } = await renderReady({ route: [], trackPoints: [point()], live: true })
    expect(map.container.querySelector('svg')).not.toBeNull()

    rerender({ route: [], trackPoints: [], live: true })
    await waitFor(() => expect(map.container.querySelector('svg')).toBeNull())
    expect(map.sources[TRAIL_SOURCE_ID].setData).toHaveBeenLastCalledWith(
      expect.objectContaining({ geometry: { type: 'LineString', coordinates: [] } })
    )
  })

  it('live mode: a second point in the same resume segment commits the prior trail and animates the tip', async () => {
    const first = point({
      id: 1,
      longitude: 0,
      latitude: 50,
      resumeSegment: 0,
      tsUtc: '2026-01-01T00:00:00.000Z'
    })
    const second = point({
      id: 2,
      longitude: 1,
      latitude: 51,
      resumeSegment: 0,
      headingTrueDeg: 100,
      tsUtc: '2026-01-01T00:00:05.000Z'
    })
    const { map, rerender } = await renderReady({ route: [], trackPoints: [first], live: true })

    await act(async () => {
      rerender({ route: [], trackPoints: [first, second], live: true })
    })

    // Committed trail is just the prior point (the animating leg is drawn on the tip
    // source instead, at animation-frame rate).
    expect(map.sources[TRAIL_SOURCE_ID].setData).toHaveBeenLastCalledWith(
      expect.objectContaining({ geometry: { type: 'MultiLineString', coordinates: [[[0, 50]]] } })
    )
    // The requestAnimationFrame mock saturates `t` at 1 on its first call, so the tip
    // source's last write already reflects the interpolation's end (the `to` point).
    expect(map.sources[TRAIL_TIP_SOURCE_ID].setData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 50],
            [1, 51]
          ]
        }
      })
    )
    expect(map.easeTo).toHaveBeenCalledWith({ center: [1, 51], duration: 5000 })
  })

  it('re-schedules the animation frame while the interpolation is still in progress', async () => {
    // Overrides the default beforeEach RAF stub (which always saturates t at 1 immediately)
    // with a real queue, so this test can drive the animation across more than one frame
    // and exercise the `t < 1` recursion itself (FlightMap.tsx's marker/tip interpolation).
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      queue.push(cb)
      return queue.length
    })

    const first = point({
      id: 1,
      longitude: 0,
      latitude: 50,
      resumeSegment: 0,
      tsUtc: '2026-01-01T00:00:00.000Z'
    })
    const second = point({
      id: 2,
      longitude: 1,
      latitude: 51,
      resumeSegment: 0,
      tsUtc: '2026-01-01T00:00:05.000Z'
    })
    const { map, rerender } = await renderReady({ route: [], trackPoints: [first], live: true })

    await act(async () => {
      rerender({ route: [], trackPoints: [first, second], live: true })
    })
    expect(queue).toHaveLength(1)

    // The component captures its own startTime a moment before this test does, so comparing
    // against an exact expected coordinate would be flaky by a few ms of real elapsed time —
    // asserting t is meaningfully between 0 and 1 (not saturated) is what this test cares
    // about, not the precise interpolated position.
    const startTime = performance.now()
    act(() => queue.shift()!(startTime + 2500)) // halfway through the 5s interpolation: t ≈ 0.5
    // Still short of t=1, so the step function re-scheduled itself for another frame.
    expect(queue).toHaveLength(1)
    const midCall = map.sources[TRAIL_TIP_SOURCE_ID].setData.mock.calls.at(-1)![0] as {
      geometry: { coordinates: [number, number][] }
    }
    const [midLon, midLat] = midCall.geometry.coordinates[1]
    expect(midLon).toBeGreaterThan(0)
    expect(midLon).toBeLessThan(1)
    expect(midLat).toBeGreaterThan(50)
    expect(midLat).toBeLessThan(51)

    act(() => queue.shift()!(startTime + 5000)) // reaches t = 1
    expect(queue).toHaveLength(0)
    expect(map.sources[TRAIL_TIP_SOURCE_ID].setData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 50],
            [1, 51]
          ]
        }
      })
    )
  })

  it('live mode: a point starting a new resume segment commits straight to the trail with no tip animation', async () => {
    const first = point({ id: 1, longitude: 0, latitude: 50, resumeSegment: 0 })
    const resumed = point({ id: 2, longitude: 9, latitude: 9, resumeSegment: 1 })
    const { map, rerender } = await renderReady({ route: [], trackPoints: [first], live: true })

    await act(async () => {
      rerender({ route: [], trackPoints: [first, resumed], live: true })
    })

    expect(map.sources[TRAIL_SOURCE_ID].setData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        geometry: { type: 'MultiLineString', coordinates: [[[0, 50]], [[9, 9]]] }
      })
    )
    expect(map.sources[TRAIL_TIP_SOURCE_ID].setData).toHaveBeenLastCalledWith(
      expect.objectContaining({ geometry: { type: 'LineString', coordinates: [] } })
    )
  })

  it('shows the follow toggle only in live mode, and toggling it locks/unlocks panning', async () => {
    const user = userEvent.setup()
    const notLive = await renderReady({ route: [], trackPoints: [], live: false })
    expect(screen.queryByRole('button', { name: /centering on aircraft|center on aircraft/i })).toBeNull()
    void notLive

    const { map } = await renderReady({ route: [], trackPoints: [point()], live: true })
    // live + followEnabled (default true) + an aircraft present -> locked, per
    // mapInteraction.ts.
    await waitFor(() => expect(map.dragPan.disable).toHaveBeenCalled())
    expect(map.scrollZoom.enable).toHaveBeenCalledWith({ around: 'center' })
    expect(map.container.classList.contains('map-pan-locked')).toBe(true)

    const toggle = screen.getByRole('button', { name: 'Stop centering on aircraft' })
    await user.click(toggle)

    await waitFor(() => expect(map.dragPan.enable).toHaveBeenCalled())
    expect(map.container.classList.contains('map-pan-locked')).toBe(false)
    expect(screen.getByRole('button', { name: 'Center on aircraft' })).toBeInTheDocument()
  })

  it('re-centers immediately when follow is switched back on', async () => {
    const user = userEvent.setup()
    const { map } = await renderReady({ route: [], trackPoints: [point()], live: true })

    await user.click(screen.getByRole('button', { name: 'Stop centering on aircraft' }))
    map.easeTo.mockClear()
    await user.click(screen.getByRole('button', { name: 'Center on aircraft' }))

    expect(map.easeTo).toHaveBeenCalledWith({ center: [-0.5, 51], duration: 500 })
  })

  it('switching follow back on with no track points yet does not try to re-center', async () => {
    const user = userEvent.setup()
    const { map } = await renderReady({ route: [], trackPoints: [], live: true })

    await user.click(screen.getByRole('button', { name: 'Stop centering on aircraft' }))
    map.easeTo.mockClear()
    await user.click(screen.getByRole('button', { name: 'Center on aircraft' }))

    expect(map.easeTo).not.toHaveBeenCalled()
  })

  it('zoom in/out buttons call straight through to the map', async () => {
    const user = userEvent.setup()
    const { map } = await renderReady({ route: [], trackPoints: [], live: false })

    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(map.zoomIn).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(map.zoomOut).toHaveBeenCalledTimes(1)
  })

  it('shows a live telemetry readout, falling back to N/A with nothing connected', async () => {
    await renderReady({ route: [], trackPoints: [], live: true, telemetry: null })
    expect(screen.getByText(/Speed: N\/A/)).toBeInTheDocument()
    expect(screen.getByText(/Altitude: N\/A/)).toBeInTheDocument()
    expect(screen.getByText(/Heading: N\/A/)).toBeInTheDocument()

    await renderReady({
      route: [],
      trackPoints: [],
      live: true,
      telemetry: {
        latitude: 0,
        longitude: 0,
        altitudeM: 3048,
        pressureAltitudeM: 3048,
        altitudeAglM: 3048,
        verticalSpeedMs: 0,
        indicatedAirspeedMs: 128.6,
        trueAirspeedMs: 128.6,
        machSpeed: 0.4,
        groundSpeedMs: 128.6,
        headingTrueDeg: 270,
        pitchDeg: 0,
        bankDeg: 0,
        onGround: false,
        gForce: 1,
        fuelTotalKg: 1000,
        totalWeightKg: 50000,
        windSpeedMs: 0,
        windDirectionDeg: 0,
        engineCombustion1: true,
        gearHandlePosition: 0,
        flapsHandleIndex: 0,
        parkingBrakeOn: false,
        atcId: 'BAW1',
        atcModel: 'A320',
        title: 'A320',
        simRate: 1,
        slewActive: false
      }
    })
    // 128.6 m/s -> ~250 kt, 3048 m -> 10,000 ft.
    expect(screen.getByText(/Speed: 250 kt/)).toBeInTheDocument()
    expect(screen.getByText(/Altitude: 10,000 ft/)).toBeInTheDocument()
    expect(screen.getByText(/Heading: 270°/)).toBeInTheDocument()
  })

  it('shows the approximate-route caption only when routeIsApproximate is set', async () => {
    await renderReady({ route: [], trackPoints: [], live: false, routeIsApproximate: false })
    expect(screen.queryByText(/no flight plan on file/)).toBeNull()

    await renderReady({ route: [], trackPoints: [], live: false, routeIsApproximate: true })
    expect(screen.getByText(/no flight plan on file/)).toBeInTheDocument()
  })
})
