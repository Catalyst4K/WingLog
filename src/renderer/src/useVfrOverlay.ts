import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  ScaleControl,
  type GeoJSONSource,
  type GeoJSONSourceSpecification,
  type Map as MapLibreMap
} from 'maplibre-gl'
import type { Airfield, AirfieldType, SimTelemetry, TrackPoint } from '@shared/ipc'
import {
  airfieldFeatureCollection,
  formatNearest,
  nearestAirfield,
  rangeRingFeatures,
  recentTrailSegments
} from './vfr'

/**
 * The Track map's VFR overlay (flightdeck-backend docs/plans/map-language-and-declutter.md,
 * Part C items 1-3): every airfield the vendored OurAirports list knows (small strips and
 * heliports included), range rings and a scale bar around the aircraft, the last few
 * minutes of track emphasised, and a nearest-airfield readout. No external service — all of
 * it comes from data WingLog already holds. Off by default; nothing is loaded or drawn until
 * the toggle is switched on, and switching it off hides the layers rather than tearing them
 * down.
 */

const AIRFIELDS_SOURCE = 'vfr-airfields'
const RINGS_SOURCE = 'vfr-range-rings'
const RECENT_TRAIL_SOURCE = 'vfr-recent-trail'

const GROUPS: {
  id: string
  types: AirfieldType[]
  minzoom: number
  labelMinzoom: number
  radius: number
  color: string
}[] = [
  {
    id: 'major',
    types: ['large_airport', 'medium_airport'],
    minzoom: 4,
    labelMinzoom: 7,
    radius: 4.5,
    color: '#e64980'
  },
  { id: 'small', types: ['small_airport'], minzoom: 7, labelMinzoom: 10, radius: 3.5, color: '#7048e8' },
  {
    id: 'minor',
    types: ['heliport', 'seaplane_base'],
    minzoom: 10,
    labelMinzoom: 12,
    radius: 3,
    color: '#868e96'
  }
]

const circleLayerId = (groupId: string): string => `${AIRFIELDS_SOURCE}-${groupId}`
const labelLayerId = (groupId: string): string => `${AIRFIELDS_SOURCE}-${groupId}-label`
const RINGS_LINE_LAYER = `${RINGS_SOURCE}-line`
const RINGS_LABEL_LAYER = `${RINGS_SOURCE}-label`
const RECENT_TRAIL_LAYER = RECENT_TRAIL_SOURCE

const ALL_LAYER_IDS = [
  ...GROUPS.flatMap((g) => [circleLayerId(g.id), labelLayerId(g.id)]),
  RINGS_LINE_LAYER,
  RINGS_LABEL_LAYER,
  RECENT_TRAIL_LAYER
]

// Both survive a FlightMap remount (switching tabs away from Track and back) — the toggle so
// it stays as the pilot left it, the list so it isn't re-sent over IPC (~43k rows).
let rememberedEnabled = false
let airfieldCache: Airfield[] | null = null

/** What a GeoJSON source accepts as data. */
type GeoData = GeoJSONSourceSpecification['data']

const emptyLines = { type: 'FeatureCollection' as const, features: [] }

function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

function multiLine(segments: [number, number][][]): GeoData {
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: segments } }
}

/** Adds every source and layer once. Airfield layers go *under* the route so the flight
 *  plan stays the most prominent thing on the map; rings and the recent trail go on top. */
function ensureLayers(map: MapLibreMap, airfields: Airfield[], routeLayerId: string): void {
  if (map.getSource(AIRFIELDS_SOURCE)) return
  const dark = isDark()
  const labelColor = dark ? '#dbe4ee' : '#343a40'
  const halo = dark ? '#0b0f14' : '#ffffff'

  map.addSource(AIRFIELDS_SOURCE, {
    type: 'geojson',
    data: airfieldFeatureCollection(airfields) as GeoData
  })
  for (const g of GROUPS) {
    const typeFilter = ['in', ['get', 'type'], ['literal', g.types]] as never
    map.addLayer(
      {
        id: circleLayerId(g.id),
        type: 'circle',
        source: AIRFIELDS_SOURCE,
        minzoom: g.minzoom,
        filter: typeFilter,
        paint: {
          'circle-radius': g.radius,
          'circle-color': g.color,
          'circle-stroke-color': halo,
          'circle-stroke-width': 1
        }
      },
      routeLayerId
    )
    map.addLayer(
      {
        id: labelLayerId(g.id),
        type: 'symbol',
        source: AIRFIELDS_SOURCE,
        minzoom: g.labelMinzoom,
        filter: typeFilter,
        layout: {
          'text-field': ['get', 'icao'],
          'text-size': 10,
          'text-offset': [0, 0.9],
          'text-anchor': 'top'
        },
        paint: { 'text-color': labelColor, 'text-halo-color': halo, 'text-halo-width': 1.2 }
      },
      routeLayerId
    )
  }

  map.addSource(RINGS_SOURCE, { type: 'geojson', data: emptyLines })
  map.addLayer({
    id: RINGS_LINE_LAYER,
    type: 'line',
    source: RINGS_SOURCE,
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#f08c00', 'line-width': 1.2, 'line-dasharray': [3, 3], 'line-opacity': 0.85 }
  })
  map.addLayer({
    id: RINGS_LABEL_LAYER,
    type: 'symbol',
    source: RINGS_SOURCE,
    filter: ['==', ['geometry-type'], 'Point'],
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 10,
      'text-anchor': 'bottom',
      'text-offset': [0, -0.2]
    },
    paint: { 'text-color': '#f08c00', 'text-halo-color': halo, 'text-halo-width': 1.2 }
  })

  map.addSource(RECENT_TRAIL_SOURCE, { type: 'geojson', data: multiLine([]) })
  map.addLayer({
    id: RECENT_TRAIL_LAYER,
    type: 'line',
    source: RECENT_TRAIL_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ff922b', 'line-width': 5, 'line-opacity': 0.9 }
  })
}

function setVisibility(map: MapLibreMap, visible: boolean): void {
  for (const id of ALL_LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
  }
}

export interface UseVfrOverlayArgs {
  mapRef: MutableRefObject<MapLibreMap | null>
  mapReady: boolean
  /** Only Track's live map gets the overlay — a finished flight has no "now" to ring. */
  live: boolean
  telemetry?: SimTelemetry | null
  trackPoints: TrackPoint[]
  /** The layer the airfield markers are inserted beneath (the planned route). */
  routeLayerId: string
}

export interface VfrOverlay {
  enabled: boolean
  toggle: () => void
  /** "EGLL Heathrow · 12.3 nm · 270°", or null when off, no position yet, or still loading. */
  nearestText: string | null
}

export function useVfrOverlay({
  mapRef,
  mapReady,
  live,
  telemetry,
  trackPoints,
  routeLayerId
}: UseVfrOverlayArgs): VfrOverlay {
  const [enabled, setEnabled] = useState(rememberedEnabled)
  const [airfields, setAirfields] = useState<Airfield[] | null>(airfieldCache)
  const scaleControlRef = useRef<ScaleControl | null>(null)
  const shownRef = useRef(false)
  const active = enabled && live

  useEffect(() => {
    rememberedEnabled = enabled
  }, [enabled])

  // Where the aircraft is: live telemetry when there is any, else the last recorded point.
  const last = trackPoints[trackPoints.length - 1]
  const latitude = telemetry?.latitude ?? last?.latitude ?? null
  const longitude = telemetry?.longitude ?? last?.longitude ?? null

  // Load the airfield list the first time the overlay is switched on.
  useEffect(() => {
    if (!active || airfields) return
    let cancelled = false
    window.winglog
      .airportListAirfields()
      .then((list) => {
        airfieldCache = list
        if (!cancelled) setAirfields(list)
      })
      .catch(() => {
        // No airfield markers, but the rings/trail/scale still work.
      })
    return () => {
      cancelled = true
    }
  }, [active, airfields])

  // Create the layers on first use, then just show/hide them.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    if (active) {
      ensureLayers(map, airfields ?? [], routeLayerId)
      setVisibility(map, true)
      if (!scaleControlRef.current) {
        scaleControlRef.current = new ScaleControl({ unit: 'nautical' })
        map.addControl(scaleControlRef.current, 'bottom-right')
      }
    } else if (shownRef.current) {
      // Only undo what was actually done — an overlay that was never switched on doesn't
      // touch the map at all.
      setVisibility(map, false)
      if (scaleControlRef.current) {
        map.removeControl(scaleControlRef.current)
        scaleControlRef.current = null
      }
    }
    shownRef.current = active
  }, [mapRef, mapReady, active, airfields, routeLayerId])

  // The airfields arrive after the layers were first created (with an empty list) — fill them in.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !active || !airfields) return
    map.getSource<GeoJSONSource>(AIRFIELDS_SOURCE)?.setData(airfieldFeatureCollection(airfields) as GeoData)
  }, [mapRef, mapReady, active, airfields])

  // Rings follow the aircraft; the recent-track emphasis follows the recorded points.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !active) return
    const position = latitude !== null && longitude !== null ? { latitude, longitude } : null
    map.getSource<GeoJSONSource>(RINGS_SOURCE)?.setData(rangeRingFeatures(position) as GeoData)
    map.getSource<GeoJSONSource>(RECENT_TRAIL_SOURCE)?.setData(multiLine(recentTrailSegments(trackPoints)))
  }, [mapRef, mapReady, active, latitude, longitude, trackPoints])

  // Torn down with the map: the control belongs to it, so just forget our handle.
  useEffect(
    () => () => {
      scaleControlRef.current = null
    },
    []
  )

  const nearestText = useMemo(() => {
    if (!active || !airfields || latitude === null || longitude === null) return null
    const nearest = nearestAirfield(latitude, longitude, airfields)
    return nearest ? formatNearest(nearest) : null
  }, [active, airfields, latitude, longitude])

  return {
    enabled,
    toggle: () => setEnabled((v) => !v),
    nearestText
  }
}
