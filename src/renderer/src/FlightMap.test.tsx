import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TrackPoint } from '@shared/ipc'
import type { Waypoint } from './route'
import type { FlightMapProps } from './FlightMap'

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

  class FakeMarker {
    private el: HTMLElement
    constructor(opts: { element: HTMLElement }) {
      this.el = opts.element
    }
    setLngLat = vi.fn()
    setRotation = vi.fn()
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

  const instances: FakeMap[] = []

  class FakeMap {
    container: HTMLElement
    style: string
    center: unknown
    zoom: number
    handlers: Record<string, (() => void)[]> = {}
    sources: Record<string, FakeSource> = {}
    layers: Record<string, { paint?: Record<string, unknown>; layout?: Record<string, unknown> }> = {}
    dragPan = { enable: vi.fn(), disable: vi.fn() }
    keyboard = { enable: vi.fn(), disable: vi.fn(), disableRotation: vi.fn() }
    scrollZoom = { enable: vi.fn() }
    touchZoomRotate = { enable: vi.fn(), disableRotation: vi.fn() }
    doubleClickZoom = { enable: vi.fn(), disable: vi.fn() }
    fitBounds = vi.fn()
    jumpTo = vi.fn()
    easeTo = vi.fn()
    zoomIn = vi.fn()
    zoomOut = vi.fn()
    remove = vi.fn()
    setLayoutProperty = vi.fn()

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
    off(): void {}
    addSource(id: string): void {
      this.sources[id] = new FakeSource()
    }
    addLayer(def: { id: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> }): void {
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
    setWorkerUrl: vi.fn(),
    __instances: instances
  }
})

const ROUTE_SOURCE_ID = 'planned-route'
const ROUTE_APPROXIMATE_LAYER_ID = 'planned-route-approximate'
const TRAIL_SOURCE_ID = 'breadcrumb-trail'
const TRAIL_TIP_SOURCE_ID = 'breadcrumb-trail-tip'
const WAYPOINT_SOURCE_ID = 'planned-waypoints'
const FOLLOW_ZOOM = 11

function point(overrides: Partial<TrackPoint> = {}): TrackPoint {
  return {
    id: 1,
    flightId: 1,
    tsUtc: '2026-01-01T00:00:00.000Z',
    latitude: 51,
    longitude: -0.5,
    altitudeM: 1000,
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
  instances: InstanceType<typeof import('maplibre-gl').Map>[]
}> {
  // Fresh module graph every call (not just every test) — some tests call renderReady more
  // than once to compare two independent mounts (e.g. light vs dark theme), and each of
  // those needs its own liveCameraState/workerReady singletons and its own __instances
  // array, not an accumulating one.
  vi.resetModules()
  const mod = await import('./FlightMap')
  const maplibre = (await import('maplibre-gl')) as unknown as {
    __instances: InstanceType<typeof import('maplibre-gl').Map>[]
  }
  return { FlightMap: mod.FlightMap, instances: maplibre.__instances }
}

/** Renders FlightMap, waits for the (mocked) map to be constructed, then fires
 *  'style.load' — the point at which the real component adds every source/layer and flips
 *  mapReady, matching maplibre-gl's own event (see FlightMap.tsx's comment on why
 *  'style.load' rather than 'load' is used). */
async function renderReady(props: FlightMapProps): ReturnType<typeof loadFlightMap> extends Promise<infer T>
  ? Promise<T & { rerender: (props: FlightMapProps) => void }>
  : never {
  const { FlightMap, instances } = await loadFlightMap()
  const { rerender } = render(<FlightMap {...props} />)
  await waitFor(() => expect(instances.length).toBe(1))
  const map = instances[0]
  await act(async () => {
    map.fireStyleLoad()
  })
  return {
    FlightMap,
    instances,
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
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:mock')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('dark')
})

describe('FlightMap', () => {
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
    expect(single.map.jumpTo).toHaveBeenCalledWith({ center: [-0.5, 51], zoom: FOLLOW_ZOOM })

    const notLive = await renderReady({
      route: [
        [-0.5, 51],
        [-1, 52]
      ],
      trackPoints: [],
      live: false
    })
    // Not live: this route-drawing effect never calls fitBounds itself (the static-trail
    // effect below handles fitting for non-live mode, with its own fallback logic).
    expect(notLive.map.fitBounds).not.toHaveBeenCalled()
  })

  it('toggles which of the two route layers is visible based on routeIsApproximate', async () => {
    const { map, rerender } = await renderReady({ route: [], trackPoints: [], live: false, routeIsApproximate: false })
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
    const { map } = await renderReady({ route: [], trackPoints: points, live: false })

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
    expect(map.jumpTo).toHaveBeenCalledWith({ center: [-0.5, 51], zoom: FOLLOW_ZOOM })
    // Marker.addTo appends the real marker element into the map's own real container div —
    // confirms it actually attached, the same thing the component's own `.isConnected`
    // checks rely on.
    expect(instances).toHaveLength(1)
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
    const first = point({ id: 1, longitude: 0, latitude: 50, resumeSegment: 0, tsUtc: '2026-01-01T00:00:00.000Z' })
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
        geometry: { type: 'LineString', coordinates: [[0, 50], [1, 51]] }
      })
    )
    expect(map.easeTo).toHaveBeenCalledWith({ center: [1, 51], duration: 5000 })
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
