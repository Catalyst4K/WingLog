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
import { useBeyondAtcHidden } from './live/use-online-status'
import { setSourceData } from './map-source'
import { mapPalette } from './flight-map/map-palette'
import { holdShortBarEnds } from '@shared/taxi/hold-short-bar'
import { useTranslation } from 'react-i18next'

const TRACE_SOURCE_ID = 'taxi-route-trace'
const TRACE_LAYER_ID = 'taxi-route-trace-line'
/** A dark edge under the line, so the yellow reads on the light map. */
const TRACE_EDGE_LAYER_ID = 'taxi-route-trace-edge'
/** The red stop bar across the end of the line where it stops at a holding point or short of a runway, and its label. */
const BAR_SOURCE_ID = 'taxi-hold-short-bar'
const BAR_LAYER_ID = 'taxi-hold-short-bar-line'
const BAR_LABEL_LAYER_ID = 'taxi-hold-short-bar-label'
const EMPTY_BAR = { type: 'FeatureCollection' as const, features: [] }

/**
 * The bar to draw for a route, or none: a bar stands at the end of the line while the clearance stops at a holding point or short of a
 * runway and ATC has not yet cleared the aircraft past it (the PC decides, see `TaxiRoute.holdShortCleared`).
 *
 * @param route The line to draw's route.
 * @param line The line itself.
 * @param label Says what the bar is in the pilot's language, given the runway or the holding point.
 * @returns The bar as GeoJSON features: its line, and its label at the end.
 */
export function holdShortBarFeatures(
  route: TaxiRoute,
  line: [number, number][],
  label: (what: { runway: string | null; point: string | null }) => string
): { type: 'FeatureCollection'; features: object[] } {
  const { holdShortRunway, holdingPoint } = route.clearance
  if (route.holdShortCleared || !(holdShortRunway || holdingPoint)) return EMPTY_BAR
  const ends = holdShortBarEnds(line)
  const end = line.at(-1)
  if (!ends || !end) return EMPTY_BAR
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ends } },
      {
        type: 'Feature',
        properties: {
          label: label({ runway: holdShortRunway, point: holdShortRunway ? null : holdingPoint })
        },
        geometry: { type: 'Point', coordinates: end }
      }
    ]
  }
}

/**
 * Adds the route's source and layer if the map doesn't have them yet.
 *
 * @param map The map.
 */
function ensureLayer(map: MapLibreMap): void {
  if (map.getSource(TRACE_SOURCE_ID)) return
  map.addSource(TRACE_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  const palette = mapPalette(document.documentElement.classList.contains('dark'))
  const layout = { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' } as const
  // The cleared route stays yellow (magenta would clash with the planned route leaving the runway), bright and thick against the
  // base chart's muted, thin line (use-taxi-chart-overlay.ts) — meant to read as "your route," not just another taxiway.
  map.addLayer({
    id: TRACE_EDGE_LAYER_ID,
    type: 'line',
    source: TRACE_SOURCE_ID,
    layout,
    paint: { 'line-color': palette.ink, 'line-width': 6, 'line-opacity': palette.taxiEdgeOpacity }
  })
  map.addLayer({
    id: TRACE_LAYER_ID,
    type: 'line',
    source: TRACE_SOURCE_ID,
    layout,
    paint: { 'line-color': palette.taxi, 'line-width': 3.5 }
  })
  map.addSource(BAR_SOURCE_ID, { type: 'geojson', data: EMPTY_BAR })
  map.addLayer({
    id: BAR_LAYER_ID,
    type: 'line',
    source: BAR_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'butt' },
    paint: { 'line-color': palette.holdBar, 'line-width': 5 }
  })
  map.addLayer({
    id: BAR_LABEL_LAYER_ID,
    type: 'symbol',
    source: BAR_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Point'],
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 11,
      'text-anchor': 'top',
      'text-offset': [0, 1],
      'text-allow-overlap': true
    },
    paint: { 'text-color': palette.holdBar, 'text-halo-color': palette.halo, 'text-halo-width': 1.4 }
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
  const { t } = useTranslation()
  const hidden = useBeyondAtcHidden()
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
    // The line comes from BeyondATC's clearance: online, the network's controllers give those instead.
    const line = enabled && !hidden ? lineToDraw(route, depIcao, arrIcao) : null
    if (!line) {
      if (createdRef.current) {
        map.setLayoutProperty(TRACE_EDGE_LAYER_ID, 'visibility', 'none')
        map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', 'none')
        map.setLayoutProperty(BAR_LAYER_ID, 'visibility', 'none')
        map.setLayoutProperty(BAR_LABEL_LAYER_ID, 'visibility', 'none')
      }
      return
    }
    ensureLayer(map)
    createdRef.current = true
    setSourceData(map, TRACE_SOURCE_ID, {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: line }
    })
    // The bar needs the whole route for its clearance, so it is drawn only for a route that is there (lineToDraw said so).
    setSourceData(
      map,
      BAR_SOURCE_ID,
      holdShortBarFeatures(route as TaxiRoute, line, ({ runway, point }) =>
        runway ? t('flightMap.holdShort', { runway }) : t('flightMap.holdAt', { point })
      ) as never
    )
    map.setLayoutProperty(TRACE_EDGE_LAYER_ID, 'visibility', 'visible')
    map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', 'visible')
    map.setLayoutProperty(BAR_LAYER_ID, 'visibility', 'visible')
    map.setLayoutProperty(BAR_LABEL_LAYER_ID, 'visibility', 'visible')
  }, [mapRef, mapReady, enabled, hidden, route, depIcao, arrIcao, t])
}
