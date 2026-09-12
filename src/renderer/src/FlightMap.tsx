import { useEffect, useRef, useState } from 'react'
import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, Marker, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Locate, LocateFixed, ZoomIn, ZoomOut } from 'lucide-react'
import type { SimTelemetry, TrackPoint } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { mapInteraction } from './mapInteraction'
import type { Waypoint } from './route'
import { mToFt, msToKt } from './units'

// maplibre-gl ships its tile-parsing worker as a separate chunk and locates it via its
// own import.meta.url at runtime — a resolution that doesn't survive Vite's dependency
// pre-bundling in dev, so pointing setWorkerUrl at Vite's resolved asset URL directly
// (maplibreWorkerUrl) was the original fix for that. Two more layers of the same class of
// bug surfaced once actually packaged, both confirmed live against a real build:
//
// 1. `?url` copies the referenced file byte-for-byte as an opaque static asset — it never
//    parses it as JS, so maplibre-gl-worker.mjs's own top-level `import ... from
//    "./maplibre-gl-shared.mjs"` was never noticed, and that sibling chunk was never
//    emitted into the build at all. Worked in dev only because Vite's dev server will
//    happily serve any file a browser asks for straight out of node_modules, sibling
//    chunk included — nothing about that generalizes to a real production build.
//    `?worker&url` is the fix: it tells Vite this file *is* a worker entry point, so it
//    traces and bundles that import's whole dependency graph into one genuinely
//    self-contained chunk, instead of copying the file as inert bytes.
// 2. Even a fully self-contained worker script still can't be loaded via `new
//    Worker(url)` from a file:// URL that points *inside* an asar archive — Chromium
//    doesn't extend the same asar transparency it gives a <script src> or a fetch() to a
//    dedicated Worker's script load. Confirmed live: style/sprite/TileJSON all fetch
//    fine, but not one .pbf tile request is ever even issued, because the worker never
//    finishes initializing. Fetching the worker's source as text (which *does* work
//    through asar, same as any other fetch) and handing maplibre a blob: URL instead
//    sidesteps the limitation — safe now that the file has no external relative import
//    left to resolve against that blob: URL. The CSP's `worker-src 'self' blob:` already
//    anticipates exactly this mechanism.
let workerReady: Promise<void> | null = null
function ensureWorkerReady(): Promise<void> {
  workerReady ??= fetch(maplibreWorkerUrl)
    .then((res) => res.blob())
    .then((blob) => setWorkerUrl(URL.createObjectURL(blob)))
  return workerReady
}

// docs/decisions.md, 2026-09-01 M4 tile source entry: OpenFreeMap, no key/quota/backend.
// positron over liberty: a low-color basemap reads better under a flight track overlay.
// 'dark' confirmed live 2026-09-08 (docs/plans/settings-ui-page.md) — a real OpenFreeMap-
// hosted style, not assumed: `curl https://tiles.openfreemap.org/styles/dark` returns a
// genuine style.json with a near-black background and matching muted layer colors, same
// URL shape as positron's. Picked once at map creation from whatever theme is active then
// (see documentElement's `dark` class, toggled by App.tsx) — deliberately not re-styled
// live if the theme changes while a map is already mounted (rare: only 'system' resolving
// differently mid-session, since every other theme change happens from Settings, which
// isn't rendering a map at all) — timeboxed, not perfected, per the plan's own framing.
const MAP_STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron'
const MAP_STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark'
function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark')
}
// `text-halo-color` draws a thin outline around each glyph, not a solid background behind
// it — with a *dark* fill colour that outline is the only part of the letter that isn't
// dark-on-dark, so on the dark basemap this app's own waypoint/taxiway labels (paint
// properties fixed at layer-creation time, unrelated to the vector style's own colours)
// went from readable to genuinely illegible once dark mode existed (real complaint,
// 2026-09-08). Picked once alongside the basemap style below, same rationale for not
// re-styling live if the theme changes mid-session.
function waypointLabelColors(dark: boolean): { color: string; halo: string } {
  return dark ? { color: '#c7d3e0', halo: '#05070a' } : { color: '#555', halo: '#fff' }
}
function taxiwayLabelColors(dark: boolean): { color: string; halo: string } {
  return dark ? { color: '#e0b24d', halo: '#05070a' } : { color: '#7a5c00', halo: '#fff' }
}
const ROUTE_SOURCE_ID = 'planned-route'
// Same source as ROUTE_SOURCE_ID's layer, drawn solid in the same blue as the flown trail
// (TRAIL_SOURCE_ID's paint below) rather than a paint-property toggle on one layer —
// line-dasharray has no "unset back to solid" value once a layer's been created with one
// (docs/plans/great-circle-fallback-route.md), so a second layer with its own fixed paint,
// switched by visibility, sidesteps that rather than fighting it.
const ROUTE_APPROXIMATE_LAYER_ID = 'planned-route-approximate'
const TRAIL_SOURCE_ID = 'breadcrumb-trail'
// The per-frame animation below used to resend the *entire* trail (every committed point
// plus the interpolated tip) to maplibre on every one of ~60 animation frames per sample —
// cost that grows with flight length, since the committed trail keeps getting longer all flight.
// Splitting the animating segment into its own tiny 2-point source means each frame only
// ever touches a constant-size payload; TRAIL_SOURCE_ID itself is only rewritten once per
// real sample (not once per frame). Same paint style as the main trail so the two read as
// one continuous line.
const TRAIL_TIP_SOURCE_ID = 'breadcrumb-trail-tip'
const WAYPOINT_SOURCE_ID = 'planned-waypoints'
// Regional view — wide enough that the aircraft doesn't outrun the viewport between
// track points (zoom 13 was street-level, well under a minute of flight across it).
const FOLLOW_ZOOM = 11

// Camera persistence across remounts (docs/plans/map-improvements.md, "cause B") —
// Track's live map is unmounted/remounted every time the user navigates away and back
// (App.tsx only renders the active page's component), which previously meant a fresh
// MapLibre instance at the [0,0]/zoom-1 default every time, before the follow effect
// snapped it back to FOLLOW_ZOOM — losing whatever zoom the user had set. Module-level,
// not React state, since it must survive the whole component unmounting; scoped to the
// live map only (Logbook's static per-flight map already fits its own bounds fresh on
// every mount via fitBoundsTo, so it has nothing worth persisting or restoring). In-
// session only, per Callum's own framing of the complaint — not persisted to app_setting.
let liveCameraState: { center: [number, number]; zoom: number } | null = null

interface LineStringFeature {
  type: 'Feature'
  properties: Record<string, never>
  geometry: { type: 'LineString'; coordinates: [number, number][] }
}

function lineString(coords: [number, number][]): LineStringFeature {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
}

interface MultiLineStringFeature {
  type: 'Feature'
  properties: Record<string, never>
  geometry: { type: 'MultiLineString'; coordinates: [number, number][][] }
}

function multiLineString(segments: [number, number][][]): MultiLineStringFeature {
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: segments } }
}

/** Splits a flight's trail at every resumeSegment boundary — never draws a line across a
 *  restart's spawn-point/teleport-back artefacts (flightdeck-backend's docs/plans/
 *  resume-track-cleanup.md), even before any cleanup logic decides which points within a
 *  segment are themselves spurious. */
function trailSegments(points: TrackPoint[]): [number, number][][] {
  const segments: [number, number][][] = []
  let current: [number, number][] = []
  let currentSegment: number | undefined
  for (const p of points) {
    if (p.resumeSegment !== currentSegment) {
      if (current.length > 0) segments.push(current)
      current = []
      currentSegment = p.resumeSegment
    }
    current.push([p.longitude, p.latitude])
  }
  if (current.length > 0) segments.push(current)
  return segments
}

interface WaypointFeatureCollection {
  type: 'FeatureCollection'
  features: {
    type: 'Feature'
    properties: { ident: string; segment: string }
    geometry: { type: 'Point'; coordinates: [number, number] }
  }[]
}

function waypointFeatures(waypoints: Waypoint[]): WaypointFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: waypoints.map((w) => ({
      type: 'Feature',
      properties: { ident: w.ident, segment: w.segment },
      geometry: { type: 'Point', coordinates: [w.lon, w.lat] }
    }))
  }
}

function fitBoundsTo(map: MapLibreMap, coords: [number, number][]): void {
  if (coords.length > 1) {
    const bounds = coords.reduce((b, coord) => b.extend(coord), new LngLatBounds(coords[0], coords[0]))
    map.fitBounds(bounds, { padding: 40, duration: 0 })
  } else if (coords.length === 1) {
    map.jumpTo({ center: coords[0], zoom: FOLLOW_ZOOM })
  }
}

export interface FlightMapProps {
  /** Planned route (from the flight's stored OFP), GeoJSON [lon, lat] order. */
  route: [number, number][]
  /** Per-fix waypoint pins along the planned route (ident labels), same source as `route`. */
  waypoints?: Waypoint[]
  trackPoints: TrackPoint[]
  /**
   * true (TrackView): animated marker/camera follow as new points arrive.
   * false (Logbook detail): draw the whole trail once and fit the view to it — the
   * flight's over, there's nothing to follow, and seeing the full route at a glance is
   * more useful for review than a zoomed-in single point.
   */
  live: boolean
  /** Live sim telemetry — shown as a small IAS/altitude/heading overlay at the map's
   *  bottom edge when present (TrackView only; Logbook/Dispatch don't pass it). */
  telemetry?: SimTelemetry | null
  /** True when `route` is a synthesized great-circle line (docs/plans/
   *  great-circle-fallback-route.md), not a real SimBrief-derived route — styled more
   *  faintly, with a caption, so it can't be mistaken for a genuine planned route. */
  routeIsApproximate?: boolean
}

// Stable reference for the default so the route/waypoint effect below doesn't re-fire on
// every render just because callers that don't pass `waypoints` get a fresh `[]` each time.
const EMPTY_WAYPOINTS: Waypoint[] = []

export function FlightMap({
  route,
  waypoints = EMPTY_WAYPOINTS,
  trackPoints,
  live,
  telemetry,
  routeIsApproximate = false
}: FlightMapProps): React.JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  // Not trackPoints.length === 1: resuming an in-progress flight loads every existing
  // point in one batch (trackPointList), so length would jump straight past 1.
  const hasCenteredRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)
  // Whether the camera keeps recentering on the aircraft as new track points arrive
  // (live mode only) — a user panning around to look at something shouldn't keep
  // getting yanked back. Defaults on, matching the always-follow behavior before this
  // was made toggleable.
  const [followEnabled, setFollowEnabled] = useState(true)

  // Map setup — once. Data is pushed in via separate effects below as it changes. Gated on
  // ensureWorkerReady() so the worker's blob: URL is registered (setWorkerUrl) before
  // MapLibreMap's constructor ever spawns the worker that needs it.
  useEffect(() => {
    if (!mapContainerRef.current) return
    let cancelled = false

    ensureWorkerReady().then(() => {
      if (cancelled || !mapContainerRef.current) return
      const dark = isDarkTheme()
      const map = new MapLibreMap({
        container: mapContainerRef.current,
        style: dark ? MAP_STYLE_DARK : MAP_STYLE_LIGHT,
        // Restores the live map's last camera position across a remount (docs/plans/
        // map-improvements.md, "cause B") instead of always starting at the whole-world
        // default — only for the live map (Logbook's static map fits its own bounds fresh
        // below regardless of what's passed here).
        center: (live && liveCameraState?.center) || [0, 0],
        zoom: (live && liveCameraState?.zoom) || 1,
        // No 3D tilt, and no rotation either (docs/plans/map-controls.md) — MapLibre's
        // defaults leave both on, both reachable via the same right-drag/Ctrl+drag
        // gesture, and there's no compass or reset-north control in this app to undo an
        // accidental rotation. `dragRotate: false` and the two `disableRotation()` calls
        // below cover the rotation half (right-drag, and the two-finger touch/keyboard
        // equivalents); `maxPitch: 0`/`touchPitch: false`/`pitchWithRotate: false` cover
        // tilt. The aircraft marker already rotates to show heading, so a fixed north-up
        // map loses nothing live tracking needs.
        maxPitch: 0,
        touchPitch: false,
        pitchWithRotate: false,
        dragRotate: false,
        // `compact: true` is MapLibre's own mechanism for exactly this attribution, and
        // OpenFreeMap's docs point to trusting MapLibre's default handling as sufficient
        // ("If you are using MapLibre, they are automatically added, you have nothing to
        // do") — confirmed 2026-09-07. Deliberately not left at its actual default
        // (`compact: undefined`, auto-decided by container width) or the `compact: false`
        // this was forced to for a time: read MapLibre's own AttributionControl source to
        // confirm what each does, rather than assume from the option name. `undefined`
        // re-evaluates on every 'resize' — the exact bug this was chasing
        // (flight-test-findings-2026-09-06.md #2): before this component's own container
        // settled to its final size, that could flip the control from collapsed to
        // expanded a moment after mount, a real layout shift confirmed live via the
        // Layout Instability API. `true` never re-evaluates by width, closing that gap —
        // but it isn't a small icon from the first frame either: MapLibre starts a
        // `compact: true` control in its *expanded* state and only collapses it to an
        // icon after the user's first drag/pan (maplibre-gl-dev.mjs's
        // `_updateCompactMinimize`, wired to the map's 'drag' event, not 'zoom'). So the
        // real, verified behavior is: no more shift, and less space taken once the user
        // actually pans the map — not "always the small icon."
        attributionControl: { compact: true }
      })
      mapRef.current = map
      // dragRotate/pitchWithRotate above already stop the mouse-drag gesture; these two
      // cover the touch and keyboard paths to rotation, which aren't constructor options.
      map.touchZoomRotate.disableRotation()
      map.keyboard.disableRotation()

      // Keeps liveCameraState current as the user pans/zooms or follow mode recentres —
      // not just captured once on unmount, so an unexpected early teardown (e.g. a fast
      // double-navigation) can't lose it. Cheap: just reading two numbers into a plain
      // variable, no re-render.
      if (live) {
        map.on('moveend', () => {
          liveCameraState = { center: map.getCenter().toArray() as [number, number], zoom: map.getZoom() }
        })
      }

      // 'load' waits for every tile in the current viewport to finish rendering — at this
      // initial [0,0]/zoom 1 (whole-world) view that can take a very long time or never
      // fully fire. 'style.load' fires once the style itself is parsed, which is all that's
      // needed to safely add sources/layers (sim-confirmed: 'load' never fired within 10s
      // in manual testing here, 'style.load' fires almost immediately).
      map.on('style.load', () => {
        map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data: lineString([]) })
        map.addLayer({
          id: ROUTE_SOURCE_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          paint: { 'line-color': '#888', 'line-width': 2, 'line-dasharray': [2, 2] }
        })
        // A synthesized great-circle route (docs/plans/great-circle-fallback-route.md) —
        // same blue as the flown trail below, so it reads as an obvious, deliberate line
        // rather than the faint "this isn't real data" grey a planned route normally gets.
        // Hidden by default; the effect below toggles which of this pair is visible.
        map.addLayer({
          id: ROUTE_APPROXIMATE_LAYER_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { visibility: 'none' },
          paint: { 'line-color': '#1a73e8', 'line-width': 3 }
        })

        map.addSource(TRAIL_SOURCE_ID, { type: 'geojson', data: lineString([]) })
        map.addLayer({
          id: TRAIL_SOURCE_ID,
          type: 'line',
          source: TRAIL_SOURCE_ID,
          paint: { 'line-color': '#1a73e8', 'line-width': 3 }
        })

        map.addSource(TRAIL_TIP_SOURCE_ID, { type: 'geojson', data: lineString([]) })
        map.addLayer({
          id: TRAIL_TIP_SOURCE_ID,
          type: 'line',
          source: TRAIL_TIP_SOURCE_ID,
          paint: { 'line-color': '#1a73e8', 'line-width': 3 }
        })

        map.addSource(WAYPOINT_SOURCE_ID, { type: 'geojson', data: waypointFeatures([]) })
        map.addLayer({
          id: `${WAYPOINT_SOURCE_ID}-circle`,
          type: 'circle',
          source: WAYPOINT_SOURCE_ID,
          paint: {
            'circle-radius': 3,
            // SID/STAR/approach fixes stand out from plain enroute waypoints — route.ts's
            // segmentation, either SimBrief's own or a live navdata-backed selection
            // (docs/plans/navdata-without-navigraph.md, Phase 5).
            'circle-color': [
              'match',
              ['get', 'segment'],
              'sid',
              '#e67700',
              'star',
              '#7048e8',
              'approach',
              '#2f9e44',
              /* enroute */ '#888'
            ],
            'circle-stroke-width': 1,
            'circle-stroke-color': '#fff'
          }
        })
        const waypointLabel = waypointLabelColors(dark)
        map.addLayer({
          id: `${WAYPOINT_SOURCE_ID}-label`,
          type: 'symbol',
          source: WAYPOINT_SOURCE_ID,
          // A long-haul OFP has well over a hundred waypoints — every ident label drawn at
          // every zoom (docs/plans/map-improvements.md #2) is the single biggest
          // contributor to a busy-looking map at wide zoom, even with MapLibre's own
          // collision detection hiding literal overlaps. The circles stay visible at every
          // zoom (no minzoom on that layer); only the text waits until there's enough
          // screen space per waypoint to actually read it against a specific leg.
          minzoom: 6,
          layout: {
            'text-field': ['get', 'ident'],
            'text-size': 11,
            'text-offset': [0, 1],
            'text-anchor': 'top'
          },
          paint: { 'text-color': waypointLabel.color, 'text-halo-color': waypointLabel.halo, 'text-halo-width': 1 }
        })

        // Taxiway designators when zoomed into an airport (docs/plans/map-improvements.md
        // #3) — needs no new data source: the base style's own vector tiles (source id and
        // aeroway layers confirmed directly against the real style JSON, 2026-09-07) already
        // carry taxiway geometry and `ref` values (e.g. "Taxiway R", "A5"), drawing the
        // lines themselves from zoom 12 already. This is purely the missing label layer.
        // Runway idents (`class == 'runway'`, e.g. "09L/27R") come from the same source
        // layer for free. Coverage is OSM-derived and varies by airport — a taxiway with no
        // `ref` in the data simply renders unlabelled, which degrades fine.
        const taxiwayLabel = taxiwayLabelColors(dark)
        map.addLayer({
          id: 'aeroway-taxiway-label',
          type: 'symbol',
          source: 'openmaptiles',
          'source-layer': 'aeroway',
          filter: ['in', ['get', 'class'], ['literal', ['taxiway', 'runway']]],
          minzoom: 14,
          layout: {
            'text-field': ['get', 'ref'],
            'text-size': 10,
            'symbol-placement': 'line',
            'text-letter-spacing': 0.05
          },
          paint: { 'text-color': taxiwayLabel.color, 'text-halo-color': taxiwayLabel.halo, 'text-halo-width': 1.2 }
        })

        // A text glyph (e.g. '✈') isn't drawn pointing true north in every font, so
        // setRotation(heading) comes out offset by whatever the glyph's own heading is.
        // This SVG is authored nose-up (pointing north at 0 rotation), so it lines up exactly.
        const el = document.createElement('div')
        el.style.width = '22px'
        el.style.height = '22px'
        el.innerHTML =
          '<svg width="22" height="22" viewBox="0 0 24 24">' +
          '<path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2.5 1.5V22l4-1 4 1v-1.5L13 19v-5.5l8 2.5z" fill="#1a73e8" stroke="#0b3d91" stroke-width="0.5"/>' +
          '</svg>'
        markerRef.current = new Marker({ element: el, rotationAlignment: 'map' })

        setMapReady(true)
      })
    })

    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
      markerRef.current = null
    }
    // Map construction must run exactly once per mount, not on every `live` change — in
    // practice a given FlightMap instance's `live` prop never actually changes across its
    // own lifetime (TrackView and LogbookView each always pass one fixed value), so
    // there's no real remount behavior being traded away here, just an intentionally
    // narrow effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Draw the planned route and its waypoint pins — falls back to nothing if the flight
  // has no stored OFP.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const routeSource = mapRef.current.getSource<GeoJSONSource>(ROUTE_SOURCE_ID)
    routeSource?.setData(lineString(route))
    const waypointSource = mapRef.current.getSource<GeoJSONSource>(WAYPOINT_SOURCE_ID)
    waypointSource?.setData(waypointFeatures(waypoints))
    if (live) fitBoundsTo(mapRef.current, route)
  }, [mapReady, route, waypoints, live])

  // Switches which of the two route layers is visible — set via setLayoutProperty rather
  // than baked in at creation, since Logbook resolves the fallback asynchronously after the
  // map's one-time setup effect has already run (a real route is known synchronously and
  // never needs this to change).
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const map = mapRef.current
    map.setLayoutProperty(ROUTE_SOURCE_ID, 'visibility', routeIsApproximate ? 'none' : 'visible')
    map.setLayoutProperty(ROUTE_APPROXIMATE_LAYER_ID, 'visibility', routeIsApproximate ? 'visible' : 'none')
  }, [mapReady, routeIsApproximate])

  // Static (Logbook) mode: draw the whole trail once and fit the view to it. No follow,
  // no animation — the flight already happened.
  useEffect(() => {
    if (!mapReady || !mapRef.current || live) return
    const coords: [number, number][] = trackPoints.map((p) => [p.longitude, p.latitude])
    const source = mapRef.current.getSource<GeoJSONSource>(TRAIL_SOURCE_ID)
    source?.setData(multiLineString(trailSegments(trackPoints)))

    const last = trackPoints[trackPoints.length - 1]
    if (last && markerRef.current) {
      markerRef.current.setLngLat([last.longitude, last.latitude])
      markerRef.current.setRotation(last.headingTrueDeg)
      if (!markerRef.current.getElement().isConnected) markerRef.current.addTo(mapRef.current)
    }
    // No flown trail to fit to yet (e.g. Dispatch's fetched-but-not-flown OFP preview) —
    // fall back to the planned route so the map still zooms to something useful instead
    // of sitting at the whole-world default view.
    fitBoundsTo(mapRef.current, coords.length > 0 ? coords : route)
  }, [mapReady, trackPoints, route, live])

  // Live (TrackView) mode: trail + marker follow the accumulated track points. The
  // marker/camera position animates across the real gap between the last two samples
  // rather than snapping — even at the tighter 2s/5s climb/cruise recording intervals
  // (see FlightRecorder.ts) a plain snap-to still reads as a jump.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !live) return

    const to = trackPoints[trackPoints.length - 1]
    const tipSource = mapRef.current.getSource<GeoJSONSource>(TRAIL_TIP_SOURCE_ID)
    if (!to) {
      // No points to show (e.g. the flight was just cancelled, finished, or auto-
      // completed) — clear both trail sources and pull the marker off the map rather than
      // leaving the last-drawn position stuck there indefinitely.
      mapRef.current.getSource<GeoJSONSource>(TRAIL_SOURCE_ID)?.setData(lineString([]))
      tipSource?.setData(lineString([]))
      if (markerRef.current?.getElement().isConnected) markerRef.current.remove()
      hasCenteredRef.current = false
      return
    }
    if (!markerRef.current) return
    if (!markerRef.current.getElement().isConnected) {
      // Marker.addTo() reads the marker's position immediately, so it must already have
      // one — attach it here, before any of the branches below, all of which assume the
      // marker is already on the map.
      markerRef.current.setLngLat([to.longitude, to.latitude])
      markerRef.current.addTo(mapRef.current)
    }

    const source = mapRef.current.getSource<GeoJSONSource>(TRAIL_SOURCE_ID)
    // Everything except the still-animating final leg — set once per real sample here, not
    // once per animation frame below, so this payload never grows on the frame's own cost.
    const priorPoints = trackPoints.slice(0, -1)

    if (!hasCenteredRef.current) {
      // First point of this mount: jump in to something usable rather than sitting at
      // whatever center/zoom the map was constructed with. No animation for this one —
      // it may be catching up on a whole batch of history from a resumed in-progress
      // flight, possibly spanning several resume segments.
      hasCenteredRef.current = true
      source?.setData(multiLineString(trailSegments(trackPoints)))
      tipSource?.setData(lineString([]))
      markerRef.current.setLngLat([to.longitude, to.latitude])
      markerRef.current.setRotation(to.headingTrueDeg)
      if (followEnabled) {
        // A remount already restored the user's last zoom via the constructor above
        // (liveCameraState) — only force FOLLOW_ZOOM on a genuinely fresh session (no
        // prior state to restore), so coming back to Track doesn't re-clobber a zoom
        // level the user had deliberately set.
        if (liveCameraState) mapRef.current.jumpTo({ center: [to.longitude, to.latitude] })
        else mapRef.current.jumpTo({ center: [to.longitude, to.latitude], zoom: FOLLOW_ZOOM })
      }
      return
    }

    const from = trackPoints[trackPoints.length - 2]
    // No prior point at all, or `to` starts a new resume segment — either way there's
    // nothing in the same segment to animate the marker in from, so commit `to` straight
    // to the trail instead of drawing a tip line across the gap.
    if (!from || from.resumeSegment !== to.resumeSegment) {
      source?.setData(multiLineString(trailSegments(trackPoints)))
      tipSource?.setData(lineString([]))
      markerRef.current.setLngLat([to.longitude, to.latitude])
      markerRef.current.setRotation(to.headingTrueDeg)
      if (followEnabled) mapRef.current.easeTo({ center: [to.longitude, to.latitude], duration: 500 })
      return
    }

    // The committed trail is done for this sample — write it once, here, not per frame.
    source?.setData(multiLineString(trailSegments(priorPoints)))

    // Rotation shows the plane's actual nose heading (not the ground track the marker is
    // animating along) — the gap between the two through a turn or in a crosswind is
    // exactly the crab angle, which is useful to see. Interpolated smoothly between the
    // two reported samples, same as position — a snap-to-latest read as a visible jump in
    // rotation each time a new sample arrived, even though it's technically the more
    // "correct" instantaneous value.
    // Shortest-path delta so e.g. 350deg -> 10deg animates through 360, not backwards
    // through 180.
    const headingDelta = ((to.headingTrueDeg - from.headingTrueDeg + 540) % 360) - 180
    // Capped so a paused sim or a stale first sample can't produce a multi-minute crawl.
    const durationMs = Math.min(
      Math.max(new Date(to.tsUtc).getTime() - new Date(from.tsUtc).getTime(), 200),
      20000
    )
    const fromCoord: [number, number] = [from.longitude, from.latitude]
    const startTime = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min((now - startTime) / durationMs, 1)
      const lng = from.longitude + (to.longitude - from.longitude) * t
      const lat = from.latitude + (to.latitude - from.latitude) * t
      markerRef.current?.setLngLat([lng, lat])
      markerRef.current?.setRotation(from.headingTrueDeg + headingDelta * t)
      // Constant-size payload (2 points) every frame, regardless of flight length — this
      // is the only thing redrawn at animation rate; the long-lived trail above isn't.
      tipSource?.setData(lineString([fromCoord, [lng, lat]]))
      if (t < 1) frame = requestAnimationFrame(step)
    })
    if (followEnabled) mapRef.current.easeTo({ center: [to.longitude, to.latitude], duration: durationMs })

    return () => cancelAnimationFrame(frame)
  }, [mapReady, trackPoints, live, followEnabled])

  // Re-center immediately when follow is switched back on, rather than waiting for the
  // next track point to arrive.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !live || !followEnabled) return
    const last = trackPoints[trackPoints.length - 1]
    if (last) mapRef.current.easeTo({ center: [last.longitude, last.latitude], duration: 500 })
    // Only on the follow-enabled transition itself — trackPoints already has its own
    // effect above driving the camera while following.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followEnabled])

  // Track's map is also `live` before any track points exist (previewing a planned
  // flight) — mapInteraction needs this so a pan lock keyed only on `live`/`followEnabled`
  // doesn't freeze that empty preview (docs/plans/map-controls.md).
  const hasAircraft = trackPoints.length > 0

  // Locks panning while genuinely following (live + follow on + an aircraft to follow),
  // and re-anchors zoom to the map's center while locked so it can't drag the view off the
  // aircraft. Reapplied whenever any of the three inputs change; Logbook's static map and
  // a not-yet-following live map always land back on MapLibre's own defaults.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const map = mapRef.current
    const config = mapInteraction(live, followEnabled, hasAircraft)

    if (config.dragPan) map.dragPan.enable()
    else map.dragPan.disable()

    if (config.keyboard) map.keyboard.enable()
    else map.keyboard.disable()

    map.scrollZoom.enable(config.scrollZoom === true ? undefined : config.scrollZoom)
    map.touchZoomRotate.enable(config.touchZoomRotate === true ? undefined : config.touchZoomRotate)

    if (config.doubleClickZoom) map.doubleClickZoom.enable()
    else map.doubleClickZoom.disable()

    // MapLibre's grab-hand cursor comes from a CSS class keyed on the map's general
    // `interactive` option (maplibre-gl.css's `.maplibregl-interactive` rule), not on
    // individual handler state — disabling dragPan alone leaves the grab hand showing.
    // This class, scoped under our own container and listed in index.css with enough
    // specificity to win over maplibre's own rule regardless of stylesheet order, forces
    // the cursor back to default while panning is locked.
    mapContainerRef.current?.classList.toggle('map-pan-locked', !config.dragPan)
  }, [mapReady, live, followEnabled, hasAircraft])

  const mapControlButtonClassName = 'bg-popover/85 backdrop-blur-sm hover:bg-popover'

  return (
    <div className="relative h-full">
      <div
        ref={mapContainerRef}
        className="h-full min-h-64 w-full overflow-hidden rounded-xl border border-border"
      />
      <div className="absolute top-3 right-3 flex flex-col gap-1.5">
        {live && (
          <Button
            type="button"
            variant={followEnabled ? 'default' : 'outline'}
            size="icon-sm"
            // "On" reads as a filled, cyan/sky-blue button rather than an icon tint —
            // `text-accent` (shadcn's subtle hover-background color, not this app's brand
            // cyan, which is `--primary`) made the "on" state nearly invisible in both
            // themes (docs/plans/map-controls.md). Backdrop blur only matters for the
            // outline style sitting over the map; the filled "on" state is opaque already.
            className={followEnabled ? undefined : mapControlButtonClassName}
            aria-label={followEnabled ? 'Stop centering on aircraft' : 'Center on aircraft'}
            title={followEnabled ? 'Stop centering on aircraft' : 'Center on aircraft'}
            aria-pressed={followEnabled}
            onClick={() => setFollowEnabled((v) => !v)}
          >
            {followEnabled ? <LocateFixed /> : <Locate />}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className={mapControlButtonClassName}
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => mapRef.current?.zoomIn()}
        >
          <ZoomIn />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className={mapControlButtonClassName}
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => mapRef.current?.zoomOut()}
        >
          <ZoomOut />
        </Button>
      </div>
      {live && (
        <div className="absolute bottom-3 left-3 rounded-full border border-border bg-popover/85 px-3 py-1 font-mono text-xs text-popover-foreground backdrop-blur-sm">
          Speed: {telemetry ? `${Math.round(msToKt(telemetry.indicatedAirspeedMs))} kt` : 'N/A'} · Altitude:{' '}
          {telemetry ? `${Math.round(mToFt(telemetry.altitudeM)).toLocaleString()} ft` : 'N/A'} · Heading:{' '}
          {telemetry ? `${Math.round(telemetry.headingTrueDeg)}°` : 'N/A'}
        </div>
      )}
      {routeIsApproximate && (
        <div className="absolute bottom-3 left-3 rounded-full border border-border bg-popover/85 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
          Approximate route — no flight plan on file for this flight
        </div>
      )}
    </div>
  )
}
