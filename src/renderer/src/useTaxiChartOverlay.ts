import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { GeoJSONSource, GeoJSONSourceSpecification, Map as MapLibreMap } from 'maplibre-gl'
import type { NavdataTaxiSegment } from '@shared/ipc'

/**
 * The Track/Logbook map's taxi chart overlay (flightdeck-backend's docs/plans/
 * taxi-network-overlay.md) — an airport's full taxiway network, drawn as a static reference
 * layer, fetched from MSFS's own SimConnect facility data. Off by default; nothing is loaded
 * or fetched until the toggle is switched on, same discipline as useVfrOverlay.ts, since a
 * large airport's fetch can genuinely take minutes (not seconds) the first time.
 */

const TAXI_SOURCE_ID = 'taxi-chart'
const TAXI_LAYER_ID = 'taxi-chart-line'
const TAXI_CHART_MINZOOM = 12

/** What a GeoJSON source accepts as data. */
type GeoData = GeoJSONSourceSpecification['data']

const emptyLines = { type: 'FeatureCollection' as const, features: [] }

function segmentsToFeatureCollection(segments: NavdataTaxiSegment[]): GeoData {
  return {
    type: 'FeatureCollection',
    features: segments.map((s) => ({
      type: 'Feature',
      properties: { name: s.name },
      geometry: {
        type: 'LineString',
        coordinates: [
          [s.startLon, s.startLat],
          [s.endLon, s.endLat]
        ]
      }
    }))
  }
}

function ensureLayer(map: MapLibreMap): void {
  if (map.getSource(TAXI_SOURCE_ID)) return
  map.addSource(TAXI_SOURCE_ID, { type: 'geojson', data: emptyLines })
  map.addLayer({
    id: TAXI_LAYER_ID,
    type: 'line',
    source: TAXI_SOURCE_ID,
    minzoom: TAXI_CHART_MINZOOM,
    layout: { visibility: 'none' },
    paint: { 'line-color': '#9c6b1f', 'line-width': 1.5, 'line-opacity': 0.75 }
  })
}

function setVisibility(map: MapLibreMap, visible: boolean): void {
  if (map.getLayer(TAXI_LAYER_ID)) map.setLayoutProperty(TAXI_LAYER_ID, 'visibility', visible ? 'visible' : 'none')
}

// Survives a FlightMap remount (switching tabs away and back) — stays as the pilot left it.
let rememberedEnabled = false
// Per-ICAO cache so switching between two already-loaded airports (or Track <-> Logbook)
// doesn't re-fetch — cleared only by a real app restart, same lifetime as useVfrOverlay's
// airfieldCache.
const segmentCache = new Map<string, NavdataTaxiSegment[]>()

export interface UseTaxiChartOverlayArgs {
  mapRef: MutableRefObject<MapLibreMap | null>
  mapReady: boolean
  depIcao: string | null
  arrIcao: string | null
}

export interface TaxiChartOverlay {
  enabled: boolean
  toggle: () => void
  /** The ICAO currently being fetched, for a caller to build a "Loading taxi chart for
   *  EGLL..." message from (translated at the call site, not baked in here) — null once
   *  every known airport is loaded (or none are known), whether the overlay is on or off. */
  loadingIcao: string | null
}

async function loadAirport(icao: string, onLoaded: (icao: string, segments: NavdataTaxiSegment[]) => void): Promise<void> {
  if (segmentCache.has(icao)) return
  const hasCached = await window.winglog.navdataHasTaxiNetwork(icao)
  if (!hasCached) await window.winglog.navdataRefreshTaxiNetwork(icao)
  const segments = await window.winglog.navdataGetTaxiNetwork(icao)
  segmentCache.set(icao, segments)
  onLoaded(icao, segments)
}

export function useTaxiChartOverlay({ mapRef, mapReady, depIcao, arrIcao }: UseTaxiChartOverlayArgs): TaxiChartOverlay {
  const [enabled, setEnabled] = useState(rememberedEnabled)
  const [loadedVersion, setLoadedVersion] = useState(0)
  const [loadingIcao, setLoadingIcao] = useState<string | null>(null)
  const shownRef = useRef(false)

  useEffect(() => {
    rememberedEnabled = enabled
  }, [enabled])

  // Stable reference across renders where dep/arr haven't actually changed, so it can sit in
  // a dependency array without re-running the effects below on every unrelated render.
  const icaos = useMemo(() => [depIcao, arrIcao].filter((icao): icao is string => Boolean(icao)), [depIcao, arrIcao])

  // Load whichever known airports aren't cached yet, the first time the overlay is switched
  // on (or a new airport becomes known while it's already on) — never automatically, and
  // never re-fetched once cached this session. The "now loading" flag is only ever set from
  // inside a microtask (queueMicrotask/.then), never synchronously in the effect body itself —
  // same "setState only in a callback from the external system" discipline useVfrOverlay's
  // own data-fetch effect already follows.
  useEffect(() => {
    if (!enabled || icaos.length === 0) return
    let cancelled = false
    for (const icao of icaos) {
      if (segmentCache.has(icao)) continue
      queueMicrotask(() => {
        if (!cancelled) setLoadingIcao(icao)
      })
      loadAirport(icao, (loadedIcao) => {
        if (cancelled) return
        setLoadingIcao((current) => (current === loadedIcao ? null : current))
        setLoadedVersion((v) => v + 1)
      }).catch(() => {
        // No chart for this airport, but the rest of the map still works.
        if (!cancelled) setLoadingIcao((current) => (current === icao ? null : current))
      })
    }
    return () => {
      cancelled = true
    }
  }, [enabled, icaos])

  // Create the layer on first use, then just show/hide it.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    if (enabled) {
      ensureLayer(map)
      setVisibility(map, true)
    } else if (shownRef.current) {
      setVisibility(map, false)
    }
    shownRef.current = enabled
  }, [mapRef, mapReady, enabled])

  // Segments arrive after the layer was first created (empty) — fill it in, merging every
  // known airport's cached segments (whichever have resolved so far).
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !enabled) return
    const segments = icaos.flatMap((icao) => segmentCache.get(icao) ?? [])
    map.getSource<GeoJSONSource>(TAXI_SOURCE_ID)?.setData(segmentsToFeatureCollection(segments))
  }, [mapRef, mapReady, enabled, loadedVersion, icaos])

  return {
    enabled,
    toggle: () => setEnabled((v) => !v),
    loadingIcao
  }
}
