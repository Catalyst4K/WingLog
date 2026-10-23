/**
 * Draws the taxi line of ATC's latest clearance on the map's taxi chart (winglog-backend's docs/plans/taxi-and-second-screen-robustness.md,
 * stage 3). The line is not worked out here: the PC traces it once, from BeyondATC's InfoBoxes and the aircraft's position, and pushes it as
 * the `taxiRoute` topic (src/main/taxi/TaxiRouteService.ts), so this window and a phone draw the same line, whichever page or chart each has
 * open. When the PC found no route the topic holds none and nothing is drawn.
 *
 * It is drawn only on a chart that is on, for an airport this map shows: a departure's line is never lit at the arrival.
 */

import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { TaxiRoute } from '@shared/live'
import { useLiveClient } from './live/LiveClient'
import { setSourceData } from './map-source'

const TRACE_SOURCE_ID = 'taxi-route-trace'
const TRACE_LAYER_ID = 'taxi-route-trace-line'

// Bright and thick against the base chart's muted, thin line (use-taxi-chart-overlay.ts) — meant to read as "your route," not just another
// taxiway.
const ROUTE_PAINT = { 'line-color': '#facc15', 'line-width': 3.5, 'line-opacity': 0.95 }

/**
 * Adds the route's source and layer if the map doesn't have them yet.
 *
 * @param map The map.
 */
function ensureLayer(map: MapLibreMap): void {
  if (map.getSource(TRACE_SOURCE_ID)) return
  map.addSource(TRACE_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: TRACE_LAYER_ID,
    type: 'line',
    source: TRACE_SOURCE_ID,
    layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
    paint: ROUTE_PAINT
  })
}

/**
 * @param route The taxi route the PC last pushed, or null.
 * @param depIcao The departure airport the map shows, or null.
 * @param arrIcao The arrival airport the map shows, or null.
 * @returns The line to draw, [lon, lat], or null when there is none: no route, no line found, or a route for an airport this map doesn't show.
 */
export function lineToDraw(
  route: TaxiRoute | null,
  depIcao: string | null | undefined,
  arrIcao: string | null | undefined
): [number, number][] | null {
  if (!route || route.kind === null || route.line.length < 2) return null
  return route.icao === depIcao || route.icao === arrIcao ? route.line : null
}

export interface UseTaxiRouteHighlightArgs {
  mapRef: MutableRefObject<MapLibreMap | null>
  mapReady: boolean
  /** Only ever shown alongside the base taxi chart — a route on a hidden chart would be invisible and confusing once the chart is turned back
   *  on. Pass `taxiChart.enabled` from useTaxiChartOverlay. */
  enabled: boolean
  depIcao: string | null | undefined
  arrIcao: string | null | undefined
}

/**
 * Draws the PC's taxi line, and keeps it as the PC pushes it.
 *
 * @param args The map, whether the chart is on, and the airports the map shows.
 */
export function useTaxiRouteHighlight({
  mapRef,
  mapReady,
  enabled,
  depIcao,
  arrIcao
}: UseTaxiRouteHighlightArgs): void {
  const client = useLiveClient()
  const [route, setRoute] = useState<TaxiRoute | null>(null)
  // Whether this hook has itself created its layer. Checked instead of calling map.getLayer() on every mount: App.tsx and LogbookView's own
  // FlightMap hosts use a simpler test fake that doesn't implement it, since nothing needed it there before.
  const createdRef = useRef(false)

  // Listens only while the chart is on: the line is pushed about once a second while the aircraft taxis, and nothing needs it otherwise. The
  // line the PC holds is asked for as the chart goes on, since a parked aircraft's line never changes and so is never pushed again.
  useEffect(() => {
    if (!enabled) return
    let live = true
    // A failed ask (the PC has no line yet) leaves what is shown until the next push.
    client.get('taxiRoute').then(
      (held) => live && setRoute(held ?? null),
      () => undefined
    )
    const stop = client.subscribe('taxiRoute', (pushed) => live && setRoute(pushed))
    return () => {
      live = false
      stop()
    }
  }, [enabled, client])

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    const line = enabled ? lineToDraw(route, depIcao, arrIcao) : null
    if (!line) {
      if (createdRef.current) map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', 'none')
      return
    }
    ensureLayer(map)
    createdRef.current = true
    setSourceData(map, TRACE_SOURCE_ID, {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: line }
    })
    map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', 'visible')
  }, [mapRef, mapReady, enabled, route, depIcao, arrIcao])
}
