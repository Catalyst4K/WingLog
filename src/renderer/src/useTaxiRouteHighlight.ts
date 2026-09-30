import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { BeyondAtcTranscriptEntry, NavdataTaxiSegment } from '@shared/ipc'
import { parseTaxiHoldingPoint, parseTaxiRoute } from './taxiRouteParser'
import { traceTaxiRoute, type TracedRoute } from './taxiRouteTrace'
import { TAXI_SOURCE_ID } from './useTaxiChartOverlay'

/**
 * Highlights BeyondATC's most recent live taxi clearance on top of the taxi chart overlay
 * (flightdeck-backend's docs/plans/beyondatc-taxi-route-highlight.md — the ATC-driven route
 * half of Part 4, built on top of Part 4a's static chart).
 *
 * Preferred: the route actually traced through the taxi network (taxiRouteTrace.ts), from
 * where the aircraft was when the clearance arrived to the named holding point, drawn as its
 * own line. Real bug that prompted it, VHHH 2026-09-30: the v1 behaviour below lit up all of
 * taxiway B across the airport for a short hop via B8, B to B10.
 *
 * Fallback, whenever a trace isn't possible (arrival/stand clearances, no holding point in
 * the data, no live position, aircraft off the network): v1's second `line` layer on the
 * same `taxi-chart` source, filtered to every segment sharing a cleared taxiway name.
 *
 * Both are limited to the clearance's own airport: a "holding point" clearance is the
 * departure's, a "taxi to stand" one the arrival's. Without this, a departure's B8/B also lit
 * up the arrival airport's own B8/B (real report, 2026-09-30).
 */

const HIGHLIGHT_LAYER_ID = 'taxi-chart-route-highlight'
const TRACE_SOURCE_ID = 'taxi-route-trace'
const TRACE_LAYER_ID = 'taxi-route-trace-line'

// Bright and thick against the base chart's muted, thin line (useTaxiChartOverlay.ts) —
// meant to read as "your route," not just another taxiway.
const ROUTE_PAINT = { 'line-color': '#facc15', 'line-width': 3.5, 'line-opacity': 0.95 }

function ensureLayers(map: MapLibreMap): void {
  if (!map.getLayer(HIGHLIGHT_LAYER_ID)) {
    map.addLayer({
      id: HIGHLIGHT_LAYER_ID,
      type: 'line',
      source: TAXI_SOURCE_ID,
      layout: { visibility: 'none' },
      paint: ROUTE_PAINT,
      filter: ['in', ['get', 'name'], ['literal', []]]
    })
  }
  if (!map.getSource(TRACE_SOURCE_ID)) {
    map.addSource(TRACE_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({
      id: TRACE_LAYER_ID,
      type: 'line',
      source: TRACE_SOURCE_ID,
      layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
      paint: ROUTE_PAINT
    })
  }
}

interface TaxiClearance {
  taxiways: string[]
  holdingPoint: string | null
  /** Where the aircraft was when the clearance arrived — the trace's start. */
  from: { lat: number; lon: number } | null
}

export interface UseTaxiRouteHighlightArgs {
  mapRef: MutableRefObject<MapLibreMap | null>
  mapReady: boolean
  /** Only ever shown alongside the base taxi chart — highlighting a route on a hidden chart
   *  would be invisible and confusing once the chart is turned back on. Pass
   *  `taxiChart.enabled` from useTaxiChartOverlay. */
  enabled: boolean
  /** `taxiChart.segmentsByIcao` — the networks the route is traced through. */
  segmentsByIcao: Record<string, NavdataTaxiSegment[]>
  depIcao: string | null
  arrIcao: string | null
  /** The aircraft's live position, or null when there's no live telemetry. */
  position: { lat: number; lon: number } | null
}

/** Survives a FlightMap remount the same way useTaxiChartOverlay's rememberedEnabled does —
 *  a route parsed before a tab switch shouldn't just vanish on return. Cleared only by a
 *  genuinely new clearance, never automatically. */
let rememberedClearance: TaxiClearance | null = null

export function useTaxiRouteHighlight({
  mapRef,
  mapReady,
  enabled,
  segmentsByIcao,
  depIcao,
  arrIcao,
  position
}: UseTaxiRouteHighlightArgs): void {
  const [clearance, setClearance] = useState<TaxiClearance | null>(rememberedClearance)
  const lastTs = useRef(0)
  const positionRef = useRef(position)
  // Whether this hook has itself created its layers. Checked instead of calling
  // map.getLayer() unconditionally on every mount (App.tsx/LogbookView.tsx's own FlightMap
  // hosts use a simpler test fake that doesn't implement getLayer, since nothing needed it
  // there before — this hook must never touch it while the base chart has never been on).
  const createdRef = useRef(false)

  useEffect(() => {
    positionRef.current = position
  }, [position])

  // Gated on `enabled` — same "nothing happens until the chart is switched on" discipline
  // useTaxiChartOverlay's own fetch effect follows. Each push carries the whole transcript,
  // so a clearance from before the chart was switched on is still picked up by the next
  // transcript line after it.
  useEffect(() => {
    if (!enabled) return
    return window.winglog.onBeyondAtcTranscript((transcript: BeyondAtcTranscriptEntry[]) => {
      let latest: TaxiClearance | null = null
      for (const entry of transcript) {
        if (entry.speaker !== 'atc' || entry.ts <= lastTs.current) continue
        lastTs.current = entry.ts
        const taxiways = parseTaxiRoute(entry.text)
        if (taxiways) latest = { taxiways, holdingPoint: parseTaxiHoldingPoint(entry.text), from: positionRef.current }
      }
      if (latest) {
        rememberedClearance = latest
        setClearance(latest)
      }
    })
  }, [enabled])

  const icao = clearance ? (clearance.holdingPoint ? depIcao : arrIcao) : null

  // Re-traced when segments finish loading too — a clearance can arrive before the chart has.
  const traced: TracedRoute | null = useMemo(() => {
    const segments = icao ? segmentsByIcao[icao] : undefined
    if (!clearance?.from || !segments || segments.length === 0) return null
    return traceTaxiRoute({ segments, taxiways: clearance.taxiways, holdingPoint: clearance.holdingPoint, from: clearance.from })
  }, [clearance, icao, segmentsByIcao])

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    if (!enabled) {
      if (createdRef.current) {
        map.setLayoutProperty(HIGHLIGHT_LAYER_ID, 'visibility', 'none')
        map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', 'none')
      }
      return
    }
    ensureLayers(map)
    createdRef.current = true

    if (traced) {
      map.getSource<GeoJSONSource>(TRACE_SOURCE_ID)?.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: traced }
      })
      map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', 'visible')
      map.setLayoutProperty(HIGHLIGHT_LAYER_ID, 'visibility', 'none')
      return
    }
    map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', 'none')
    const names = clearance?.taxiways ?? []
    map.setLayoutProperty(HIGHLIGHT_LAYER_ID, 'visibility', names.length > 0 ? 'visible' : 'none')
    if (names.length > 0) {
      const byName = ['in', ['get', 'name'], ['literal', names]]
      map.setFilter(
        HIGHLIGHT_LAYER_ID,
        (icao ? ['all', byName, ['==', ['get', 'icao'], icao]] : byName) as Parameters<MapLibreMap['setFilter']>[1]
      )
    }
  }, [mapRef, mapReady, enabled, clearance, traced, icao])
}
