/**
 * FlightMap's MapLibre plumbing: the worker, the base styles, the map's own sources and layers,
 * and the small GeoJSON and camera helpers its effects use.
 */

import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  setWorkerUrl,
  type ExpressionSpecification
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { MapLanguage, TrackPoint } from '@shared/ipc'
import { lazy } from '@shared/lazy'
import { planStyleChanges, type StyleLayerLike } from '../map-labels'
import type { Waypoint } from '../route'
import { uiMemory } from '../ui-memory'

// maplibre-gl ships its tile-parsing worker as a separate chunk and locates it via its own import.meta.url, which doesn't
// survive Vite's dependency pre-bundling in dev, so setWorkerUrl points at Vite's resolved asset URL (maplibreWorkerUrl).
// Two more problems appeared only in a packaged build:
//
// 1. `?url` copies the file as an opaque static asset and never parses it as JS, so the worker's top-level
//    `import ... from "./maplibre-gl-shared.mjs"` went unnoticed and that sibling chunk was never emitted. (Dev worked only
//    because Vite's dev server serves any file out of node_modules.) `?worker&url` marks the file as a worker entry, so
//    Vite bundles its whole dependency graph into one self-contained chunk.
// 2. Even a self-contained worker can't be loaded via `new Worker(url)` from a file:// URL inside an asar archive:
//    Chromium doesn't give a dedicated Worker's script load the asar transparency it gives <script src> or fetch(). Style,
//    sprite and TileJSON fetch fine, but no .pbf tile request is ever issued. Fetching the worker's source as text (which
//    works through asar) and handing maplibre a blob: URL sidesteps it, safe now that the file has no relative import left
//    to resolve. The CSP's `worker-src 'self' blob:` anticipates this.
export const ensureWorkerReady = lazy((): Promise<void> =>
  fetch(maplibreWorkerUrl)
    .then((res) => res.blob())
    .then((blob) => setWorkerUrl(URL.createObjectURL(blob)))
)

// docs/decisions.md, 2026-09-01 M4 tile source entry: OpenFreeMap, no key/quota/backend. positron over liberty: a
// low-color basemap reads better under a flight track overlay. 'dark' is a real OpenFreeMap style with a near-black
// background and muted layer colors (docs/plans/settings-ui-page.md), the same URL shape as positron's. The style is picked
// once at map creation from the active theme (documentElement's `dark` class, toggled by App.tsx) and not re-styled live
// if the theme changes while a map is mounted: that is rare (only 'system' resolving differently mid-session), since every
// other theme change happens from Settings, which renders no map.
const MAP_STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron'
const MAP_STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark'

/**
 * Whether the app is in its dark theme right now.
 *
 * @returns True when the document carries the `dark` class.
 */
export function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark')
}

// `text-halo-color` draws a thin outline around each glyph, not a solid background. With a *dark* fill colour the outline is
// the only part of the letter that isn't dark-on-dark, so on the dark basemap this app's own waypoint and taxiway labels
// (paint properties fixed at layer creation, independent of the vector style's colours) were illegible. Picked once
// alongside the basemap style below, and not re-styled live for the same reason.
function waypointLabelColors(dark: boolean): { color: string; halo: string } {
  return dark ? { color: '#c7d3e0', halo: '#05070a' } : { color: '#555', halo: '#fff' }
}
function taxiwayLabelColors(dark: boolean): { color: string; halo: string } {
  return dark ? { color: '#e0b24d', halo: '#05070a' } : { color: '#7a5c00', halo: '#fff' }
}
export const ROUTE_SOURCE_ID = 'planned-route'
// Same source as ROUTE_SOURCE_ID's layer, drawn solid in the same blue as the flown trail
// (TRAIL_SOURCE_ID's paint below) rather than a paint-property toggle on one layer —
// line-dasharray has no "unset back to solid" value once a layer's been created with one
// (docs/plans/great-circle-fallback-route.md), so a second layer with its own fixed paint,
// switched by visibility, sidesteps that rather than fighting it.
export const ROUTE_APPROXIMATE_LAYER_ID = 'planned-route-approximate'
export const TRAIL_SOURCE_ID = 'breadcrumb-trail'
// The per-frame animation below used to resend the *entire* trail (every committed point
// plus the interpolated tip) to maplibre on every one of ~60 animation frames per sample —
// cost that grows with flight length, since the committed trail keeps getting longer all flight.
// Splitting the animating segment into its own tiny 2-point source means each frame only
// ever touches a constant-size payload; TRAIL_SOURCE_ID itself is only rewritten once per
// real sample (not once per frame). Same paint style as the main trail so the two read as
// one continuous line.
export const TRAIL_TIP_SOURCE_ID = 'breadcrumb-trail-tip'
export const WAYPOINT_SOURCE_ID = 'planned-waypoints'
// fitBoundsTo's zoom for a single coordinate (nothing to fit a box around). Following the
// aircraft uses follow-zoom.ts's ground/altitude bands instead.
const SINGLE_POINT_ZOOM = 12

// Camera persistence across remounts (docs/plans/map-improvements.md, "cause B") —
// The live map's camera, its "Center on aircraft" toggle and the route it was framed for survive
// a remount (leaving Track and coming back) in ui-memory.ts; Logbook's static map fits its
// bounds fresh every mount.

/**
 * A short key identifying a route, so a remount can tell whether the remembered camera was
 * framed for the same one.
 *
 * @param route The route.
 * @returns The key, or '' for no route.
 */
export function routeKey(route: [number, number][]): string {
  return route.length === 0 ? '' : `${route.length}:${route[0]?.join(',')}:${route.at(-1)?.join(',')}`
}

interface LineStringFeature {
  type: 'Feature'
  properties: Record<string, never>
  geometry: { type: 'LineString'; coordinates: [number, number][] }
}

/**
 * A GeoJSON line through the given coordinates.
 *
 * @param coords The coordinates, [lon, lat].
 * @returns The feature.
 */
export function lineString(coords: [number, number][]): LineStringFeature {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
}

interface MultiLineStringFeature {
  type: 'Feature'
  properties: Record<string, never>
  geometry: { type: 'MultiLineString'; coordinates: [number, number][][] }
}

/**
 * A GeoJSON multi-line, one line per segment.
 *
 * @param segments The segments' coordinates, [lon, lat].
 * @returns The feature.
 */
export function multiLineString(segments: [number, number][][]): MultiLineStringFeature {
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: segments } }
}

/**
 * Splits a flight's trail at every resumeSegment boundary — never draws a line across a
 * restart's spawn-point/teleport-back artefacts (winglog-backend's docs/plans/
 * resume-track-cleanup.md), even before any cleanup logic decides which points within a
 * segment are themselves spurious.
 *
 * @param points The flight's track points.
 * @returns The track as line segments, split at each resume gap.
 */
export function trailSegments(points: TrackPoint[]): [number, number][][] {
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

/**
 * The waypoints as GeoJSON points carrying their ident and route segment.
 *
 * @param waypoints The waypoints.
 * @returns The feature collection.
 */
export function waypointFeatures(waypoints: Waypoint[]): WaypointFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: waypoints.map((w) => ({
      type: 'Feature',
      properties: { ident: w.ident, segment: w.segment },
      geometry: { type: 'Point', coordinates: [w.lon, w.lat] }
    }))
  }
}

/**
 * Rewrites the hosted base style's name labels to one language and pushes low-value place
 * labels to a later zoom (map-labels.ts). Best-effort by design: it's a third-party style
 * with no version pin, so any surprise — a missing layer, a changed shape — leaves the map
 * as the style drew it rather than breaking it.
 *
 * @param map The map.
 * @param language The map language.
 */
export function applyLabelStyle(map: MapLibreMap, language: MapLanguage): void {
  try {
    const layers = map.getStyle().layers as StyleLayerLike[]
    for (const change of planStyleChanges(layers, language)) {
      if (change.textField)
        map.setLayoutProperty(change.id, 'text-field', change.textField as ExpressionSpecification)
      if (change.minzoom !== undefined) {
        const maxzoom = layers.find((l) => l.id === change.id)?.maxzoom ?? 24
        map.setLayerZoomRange(change.id, change.minzoom, maxzoom)
      }
    }
  } catch {
    // Leave the style alone.
  }
}

/**
 * Frames the given coordinates: fits a box around several, or centres on one.
 *
 * @param map The map.
 * @param coords The coordinates, [lon, lat]. Nothing happens for none.
 */
export function fitBoundsTo(map: MapLibreMap, coords: [number, number][]): void {
  if (coords.length > 1) {
    const bounds = coords.reduce((b, coord) => b.extend(coord), new LngLatBounds(coords[0], coords[0]))
    map.fitBounds(bounds, { padding: 40, duration: 0 })
  } else if (coords.length === 1) {
    map.jumpTo({ center: coords[0], zoom: SINGLE_POINT_ZOOM })
  }
}

/**
 * Creates the map in its container, north-up with no tilt, and — for the live map — starts
 * remembering its camera in ui-memory.ts.
 *
 * @param container The element the map draws into.
 * @param live Whether this is Track's live map.
 * @param dark Whether to use the dark base style.
 * @returns The map.
 */
export function createFlightMap(container: HTMLDivElement, live: boolean, dark: boolean): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style: dark ? MAP_STYLE_DARK : MAP_STYLE_LIGHT,
    // Restores the live map's last camera position across a remount (docs/plans/
    // map-improvements.md, "cause B") instead of always starting at the whole-world
    // default — only for the live map (Logbook's static map fits its own bounds fresh
    // below regardless of what's passed here).
    center: (live && uiMemory().liveCamera?.center) || [0, 0],
    zoom: (live && uiMemory().liveCamera?.zoom) || 1,
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
    // `compact: true` is MapLibre's mechanism for this attribution, and OpenFreeMap's docs say MapLibre's default handling is
    // sufficient. Not left at its default (`compact: undefined`, auto-decided by container width) or `compact: false`
    // (MapLibre's AttributionControl source shows what each does): `undefined` re-evaluates on every 'resize', so before this
    // component's container settled it could flip the control from collapsed to expanded after mount, a layout shift
    // (flight-test-findings-2026-09-06.md #2). `true` never re-evaluates by width, closing that gap, but MapLibre starts a
    // `compact: true` control *expanded* and only collapses it to an icon after the first drag (`_updateCompactMinimize`, on
    // 'drag', not 'zoom'): no more shift, and less space taken once the user pans, not "always the small icon".
    attributionControl: { compact: true }
  })
  // dragRotate/pitchWithRotate above already stop the mouse-drag gesture; these two
  // cover the touch and keyboard paths to rotation, which aren't constructor options.
  map.touchZoomRotate.disableRotation()
  map.keyboard.disableRotation()

  // Keeps uiMemory().liveCamera current as the user pans/zooms or follow mode recentres —
  // not just captured once on unmount, so an unexpected early teardown (e.g. a fast
  // double-navigation) can't lose it. Cheap: just reading two numbers into a plain
  // variable, no re-render.
  if (live) {
    map.on('moveend', () => {
      uiMemory().liveCamera = {
        center: map.getCenter().toArray() as [number, number],
        zoom: map.getZoom()
      }
    })
    // originalEvent is only set for a zoom the user made (wheel, pinch, double-click).
    map.on('zoomend', (e) => {
      if (e.originalEvent) uiMemory().liveZoomChosenByUser = true
    })
  }
  return map
}

/**
 * Adds the map's own sources and layers — planned route, flown trail, waypoints and
 * taxiway labels — once the style has loaded, and builds the aircraft marker.
 *
 * @param map The map, its style loaded.
 * @param dark Whether the dark base style is in use, for the label colours.
 * @returns The aircraft marker, not yet on the map.
 */
export function addFlightLayers(map: MapLibreMap, dark: boolean): Marker {
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
  // Hidden by default; FlightMap's effect toggles which of this pair is visible.
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

  addWaypointLayers(map, dark)
  addTaxiwayLabels(map, dark)
  return aircraftMarker()
}

/**
 * Adds the route waypoint source and its circle and label layers, coloured by route segment.
 *
 * @param map The map.
 * @param dark Whether the dark theme is on.
 */
function addWaypointLayers(map: MapLibreMap, dark: boolean): void {
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
    paint: {
      'text-color': waypointLabel.color,
      'text-halo-color': waypointLabel.halo,
      'text-halo-width': 1
    }
  })
}

/**
 * Adds the taxiway and runway labels the base style's own tiles carry, shown only when zoomed in to an
 * airport.
 *
 * @param map The map.
 * @param dark Whether the dark theme is on.
 */
function addTaxiwayLabels(map: MapLibreMap, dark: boolean): void {
  // Taxiway designators when zoomed into an airport (docs/plans/map-improvements.md #3). Needs no new data source: the base
  // style's own vector tiles already carry taxiway geometry and `ref` values (e.g. "Taxiway R", "A5") and draw the lines
  // from zoom 12, so this is only the missing label layer. Runway idents (`class == 'runway'`, e.g. "09L/27R") come from
  // the same source layer. Coverage is OSM-derived and varies by airport; a taxiway with no `ref` renders unlabelled.
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
    paint: {
      'text-color': taxiwayLabel.color,
      'text-halo-color': taxiwayLabel.halo,
      'text-halo-width': 1.2
    }
  })
}

function aircraftMarker(): Marker {
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
  return new Marker({ element: el, rotationAlignment: 'map' })
}
