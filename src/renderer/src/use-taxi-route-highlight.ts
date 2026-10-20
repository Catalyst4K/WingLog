/**
 * Highlights BeyondATC's most recent live taxi clearance on top of the taxi chart overlay (winglog-backend's
 * docs/plans/beyondatc-taxi-route-highlight.md: the ATC-driven route half of Part 4, built on Part 4a's static chart).
 *
 * Preferred: the route traced through the taxi network (taxi-route-trace.ts), from where the aircraft was when the clearance
 * arrived to the holding point (or, for a stand, to where it joins the last cleared taxiway), drawn as its own line starting at
 * the aircraft and shortening as it taxis (remainingRoute). Without a trace, a short hop via B8, B to B10 lit up all of
 * taxiway B across the airport.
 *
 * Fallback, whenever a trace isn't possible (the holding point isn't in the data, no live position, aircraft off the
 * network): a second `line` layer on the same `taxi-chart` source, filtered to every segment sharing a cleared taxiway name.
 *
 * The clearance comes only from BeyondATC's InfoBoxes (`Taxi Via 1..n`, `Hold Position`, `Hold Short`, `Taxi to Gate`;
 * boxTaxiClearance), never from parsing the speech.
 *
 * Re-routing (winglog-backend's docs/plans/taxi-reroute.md): when the aircraft leaves the line, or drives the wrong way along
 * it, while taxiing, the line is redrawn as the shortest way from where it is to the same end, rejoining the cleared route
 * wherever that's shortest (taxi-reroute.ts decides when, rejoinTaxiRoute where). A re-route that can't be traced (off the
 * network) keeps the line it had. Once the aircraft reaches the end, nothing re-routes.
 *
 * Both are limited to the clearance's own airport: a "holding point" clearance is the departure's, a "taxi to stand" one the
 * arrival's. Otherwise a departure's B8/B also lit up the arrival airport's own B8/B.
 */

import { winglogApi } from './data/winglog-api'
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { BeyondAtcState, FlightPhase, NavdataStand, NavdataTaxiSegment } from '@shared/ipc'
import { findStand } from '@shared/stands'
import type { RunwayStrip, TracedRoute } from './taxi-route-trace'
import {
  clearanceAirport,
  clearanceRunway,
  clearanceRunwayThreshold,
  startOf,
  traceClearanceDetailed,
  type TaxiClearance
} from './taxi-clearance'
import type { TracedClearance, TraceKind } from './taxi-fallback'
import { startTracker, trackPosition, type RerouteTracker } from './taxi-reroute'
import { isDeparted, stepTaxiBoxes } from './taxi-clearance-step'
import { diagMap } from './diag'
import { setSourceData } from './map-source'
import { TAXI_SOURCE_ID } from './use-taxi-chart-overlay'
import { useLiveClient } from './live/LiveClient'
import { uiMemory } from './ui-memory'

const HIGHLIGHT_LAYER_ID = 'taxi-chart-route-highlight'
const TRACE_SOURCE_ID = 'taxi-route-trace'
const TRACE_LAYER_ID = 'taxi-route-trace-line'
// The same line drawn dashed, for one the pathfinder found rather than one traced through the cleared taxiways: an estimate.
const TRACE_DASHED_LAYER_ID = 'taxi-route-trace-line-dashed'

// Bright and thick against the base chart's muted, thin line (use-taxi-chart-overlay.ts) —
// meant to read as "your route," not just another taxiway.
const ROUTE_PAINT = { 'line-color': '#facc15', 'line-width': 3.5, 'line-opacity': 0.95 }

/**
 * Adds the taxi route highlight layers if the map doesn't have them yet.
 *
 * @param map The map.
 */
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
    map.addLayer({
      id: TRACE_DASHED_LAYER_ID,
      type: 'line',
      source: TRACE_SOURCE_ID,
      layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'butt' },
      paint: { ...ROUTE_PAINT, 'line-dasharray': [2, 1.5] }
    })
  }
}

/**
 * Shows the traced line solid, dashed (an estimate), or not at all.
 *
 * @param map The map.
 * @param show Which to show.
 */
function showTraceLine(map: MapLibreMap, show: TraceKind | 'none'): void {
  map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', show === 'exact' ? 'visible' : 'none')
  map.setLayoutProperty(TRACE_DASHED_LAYER_ID, 'visibility', show === 'pathfinder' ? 'visible' : 'none')
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
  /** The aircraft's live position, heading (degrees true) and ground speed, or null when
   *  there's no live telemetry. Heading and speed are what re-routing needs. */
  position: { lat: number; lon: number; headingDeg?: number; groundSpeedMs?: number } | null
  /** The active flight's phase, or null with no active flight. */
  phase: FlightPhase | null
}

/**
 * Takes the clearance from a new set of taxi boxes into the remembered state.
 *
 * @param state BeyondATC's state.
 * @param position The aircraft's position now, where the clearance starts.
 * @param setClearance Sets the hook's clearance.
 */
function ingestBoxes(
  state: BeyondAtcState,
  position: { lat: number; lon: number } | null,
  setClearance: (clearance: TaxiClearance) => void
): void {
  const result = stepTaxiBoxes(uiMemory().taxiRoute, state.infoBoxes, position, Date.now())
  uiMemory().taxiRoute = result.memory
  if (result.clearance) setClearance(result.clearance)
}

/**
 * The arrival airport's stands, once a stand clearance needs one (fetched from the sim on
 * first ask, then cached — stand-positions.md).
 *
 * @param enabled Whether the taxi chart is on.
 * @param clearance The clearance, or null.
 * @param icao The clearance's airport, or null.
 * @returns The cleared stand, positioned, or null.
 */
function useClearanceStand(
  enabled: boolean,
  clearance: TaxiClearance | null,
  icao: string | null
): NavdataStand | null {
  const [stands, setStands] = useState<{ icao: string; list: NavdataStand[] } | null>(null)
  const standIcao = enabled && clearance?.stand && icao ? icao : null
  useEffect(() => {
    if (!standIcao) return
    let ignore = false
    // No stands (the sim isn't connected): the route ends where it joins the last taxiway.
    winglogApi()
      .navdataGetStands(standIcao)
      .then(
        (list) => {
          if (!ignore) setStands({ icao: standIcao, list })
        },
        () => undefined
      )
    return () => {
      ignore = true
    }
  }, [standIcao])
  return clearance?.stand && stands && stands.icao === icao ? findStand(stands.list, clearance.stand) : null
}

/**
 * The threshold of the runway a holding-point clearance is for ("taxi to holding point A, runway 05L"), which picks the taxiway's
 * hold short beside it. Read from the navdata cache, so null when the airport isn't cached; the line is then drawn as before.
 *
 * @param enabled Whether the taxi chart is on.
 * @param clearance The clearance, or null.
 * @param icao The clearance's airport, or null.
 * @returns The threshold, or null.
 */
export function useClearanceRunway(
  enabled: boolean,
  clearance: TaxiClearance | null,
  icao: string | null
): { lat: number; lon: number } | null {
  const [found, setFound] = useState<{
    icao: string
    ident: string
    threshold: { lat: number; lon: number }
  } | null>(null)
  const ident =
    enabled && clearance?.holdingPoint && clearance.taxiToRunway && icao ? clearance.taxiToRunway : null
  useEffect(() => {
    if (!ident || !icao) return
    let ignore = false
    // A runway list that can't be had leaves the line drawn as before, so a failure, even a missing call, is only swallowed.
    Promise.resolve()
      .then(() => winglogApi().navdataListRunways(icao))
      .then(
        (runways) => {
          const threshold = clearanceRunwayThreshold(ident, runways)
          if (!ignore && threshold) setFound({ icao, ident, threshold })
        },
        () => undefined
      )
    return () => {
      ignore = true
    }
  }, [ident, icao])
  // The stored object itself, never a copy: the line is traced again whenever this changes, and a new object on every render re-traced it on
  // every render and restarted its re-routing each time, so the line never followed a wrong turn.
  return ident && found && found.icao === icao && found.ident === ident ? found.threshold : null
}

/**
 * The runway of a "hold short of runway 34R" clearance, which picks the hold short beside it. Null when the airport isn't cached or
 * the clearance has a holding point (the runway is then the threshold hook's); the line is then drawn as before.
 *
 * @param enabled Whether the taxi chart is on.
 * @param clearance The clearance, or null.
 * @param icao The clearance's airport, or null.
 * @returns The runway, or null.
 */
export function useHoldShortRunway(
  enabled: boolean,
  clearance: TaxiClearance | null,
  icao: string | null
): RunwayStrip | null {
  const [found, setFound] = useState<{ icao: string; ident: string; runway: RunwayStrip } | null>(null)
  const ident =
    enabled && !clearance?.holdingPoint && clearance?.holdShortRunway && icao
      ? clearance.holdShortRunway
      : null
  useEffect(() => {
    if (!ident || !icao) return
    let ignore = false
    Promise.resolve()
      .then(() => winglogApi().navdataListRunways(icao))
      .then(
        (runways) => {
          const runway = clearanceRunway(ident, runways)
          if (!ignore && runway) setFound({ icao, ident, runway })
        },
        () => undefined
      )
    return () => {
      ignore = true
    }
  }, [ident, icao])
  // The stored object itself, never a copy (see useClearanceRunway).
  return ident && found && found.icao === icao && found.ident === ident ? found.runway : null
}

/**
 * Draws the traced line from the aircraft, re-routing first if it has left the line.
 *
 * @param map The map.
 * @param tracker The clearance's tracker.
 * @param position The aircraft's position, or null.
 * @param phase The flight phase, or null.
 * @param segments The airport's taxi network.
 * @param kind How the line was made: a pathfinder line is drawn dashed.
 * @returns The tracker after this update.
 */
function drawTracedLine(
  map: MapLibreMap,
  tracker: RerouteTracker,
  position: UseTaxiRouteHighlightArgs['position'],
  phase: FlightPhase | null,
  segments: NavdataTaxiSegment[] | undefined,
  kind: TraceKind
): RerouteTracker {
  let next = tracker
  let line = tracker.active
  if (position) {
    const update = trackPosition(tracker, { position, phase, nowMs: Date.now(), segments })
    next = update.tracker
    if (update.rerouted) {
      diagMap('taxi route re-routed', {
        at: position,
        points: update.tracker.active.length,
        end: update.tracker.active.at(-1)
      })
    }
    line = update.line
  }
  setSourceData(map, TRACE_SOURCE_ID, {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: line }
  })
  showTraceLine(map, kind)
  map.setLayoutProperty(HIGHLIGHT_LAYER_ID, 'visibility', 'none')
  return next
}

/**
 * Without a traced line: every segment of the cleared taxiways, at the clearance's airport
 * when it's known.
 *
 * @param map The map.
 * @param names The cleared taxiways.
 * @param icao The clearance's airport, or null.
 */
function drawWholeTaxiways(map: MapLibreMap, names: string[], icao: string | null): void {
  showTraceLine(map, 'none')
  map.setLayoutProperty(HIGHLIGHT_LAYER_ID, 'visibility', names.length > 0 ? 'visible' : 'none')
  if (names.length > 0) {
    const byName = ['in', ['get', 'name'], ['literal', names]]
    map.setFilter(
      HIGHLIGHT_LAYER_ID,
      (icao ? ['all', byName, ['==', ['get', 'icao'], icao]] : byName) as Parameters<
        MapLibreMap['setFilter']
      >[1]
    )
  }
}

/**
 * The line for a clearance. Re-traced when the segments finish loading too: a clearance can arrive before the chart has.
 *
 * @param clearance The clearance, or null.
 * @param segments The clearance airport's taxi network, once loaded.
 * @param where The cleared stand's position, the cleared runway's threshold, and the runway of a hold short clearance.
 * @returns The line with how it was made, or null.
 */
function useTracedClearance(
  clearance: TaxiClearance | null,
  segments: NavdataTaxiSegment[] | undefined,
  where: {
    standPosition: NavdataStand | null
    runwayThreshold: { lat: number; lon: number } | null
    holdShortRunway: RunwayStrip | null
  }
): TracedClearance | null {
  const { standPosition, runwayThreshold, holdShortRunway } = where
  return useMemo(() => {
    if (!clearance?.from || !segments || segments.length === 0) return null
    return traceClearanceDetailed(clearance, segments, standPosition, runwayThreshold, holdShortRunway)
  }, [clearance, segments, standPosition, runwayThreshold, holdShortRunway])
}

/**
 * Logs each new trace: how the line was made (traced, or found by the pathfinder), and which cleared taxiways it doesn't match.
 *
 * @param clearance The clearance, or null.
 * @param traced Its line with how it was made, or null.
 * @param icao The clearance's airport, or null.
 */
function useLogTrace(
  clearance: TaxiClearance | null,
  traced: TracedClearance | null,
  icao: string | null
): void {
  useEffect(() => {
    if (!clearance) return
    diagMap(traced ? `taxi route traced (${traced.kind})` : 'taxi route not traced: whole taxiways instead', {
      icao,
      taxiways: clearance.taxiways,
      holdingPoint: clearance.holdingPoint,
      stand: clearance.stand,
      holdShortRunway: clearance.holdShortRunway,
      from: clearance.from,
      match: traced?.match ?? null,
      points: traced?.route.length ?? 0,
      end: traced?.route.at(-1) ?? null
    })
    // Logged once per new trace, not when the clearance object alone changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearance/icao are read only to describe this trace
  }, [traced])
}

/**
 * Says why a clearance has no traced line. A clearance that never traces leaves `traced` null before and after, so the trace's own log
 * line never comes for it (WSSS 2026-10-19: a clearance with no holding point was taken for the arrival's, found no taxi network, and the
 * log said nothing).
 *
 * @param clearance The clearance, or null.
 * @param traced Its traced line, or null.
 * @param icao The clearance's airport, or null.
 * @param segments That airport's taxi network, once loaded.
 */
export function useLogUntraced(
  clearance: TaxiClearance | null,
  traced: TracedRoute | null,
  icao: string | null,
  segments: NavdataTaxiSegment[] | undefined
): void {
  useEffect(() => {
    if (clearance && !traced) {
      diagMap('taxi clearance not traced yet', {
        icao,
        taxiways: clearance.taxiways,
        haveSegments: (segments?.length ?? 0) > 0,
        hasPosition: clearance.from !== null
      })
    }
  }, [clearance, traced, icao, segments])
}

// The clearance and what's been read survive a FlightMap remount (ui-memory.ts): a route parsed
// before a tab switch doesn't vanish, old clearances aren't re-read as new, and leaving Track at
// the holding point then coming back in cruise still drops the departure's route.

/**
 * Draws the latest taxi clearance's route and keeps it up to date as the aircraft taxis.
 *
 * @param args The map, the taxi networks, the flight's airports, and the aircraft's position and phase.
 */
export function useTaxiRouteHighlight({
  mapRef,
  mapReady,
  enabled,
  segmentsByIcao,
  depIcao,
  arrIcao,
  position,
  phase
}: UseTaxiRouteHighlightArgs): void {
  const [clearance, setClearance] = useState<TaxiClearance | null>(uiMemory().taxiRoute.clearance)
  const client = useLiveClient()
  const positionRef = useRef(position)
  /** The current clearance's line between position updates (taxi-reroute.ts). */
  const trackerRef = useRef<RerouteTracker | null>(null)
  // Whether this hook has itself created its layers. Checked instead of calling
  // map.getLayer() unconditionally on every mount (App.tsx/LogbookView.tsx's own FlightMap
  // hosts use a simpler test fake that doesn't implement getLayer, since nothing needed it
  // there before — this hook must never touch it while the base chart has never been on).
  const createdRef = useRef(false)

  useEffect(() => {
    positionRef.current = position
  }, [position, phase])

  // Gated on `enabled`: nothing happens until the chart is switched on, as in useTaxiChartOverlay's fetch effect. The boxes
  // BeyondATC already has are read straight away, not just on the next push, so a clearance given while Track wasn't
  // open isn't left waiting for ATC's next line.
  useEffect(() => {
    if (!enabled) return
    let live = true
    const ingestState = (state: BeyondAtcState): void => {
      if (live) ingestBoxes(state, positionRef.current, setClearance)
    }
    // A failed first read (BeyondATC not connected) has nothing to show; the subscriptions bring
    // the next update.
    client.get('beyondAtcState').then(
      (state) => state && ingestState(state),
      () => undefined
    )
    const unsubscribeBoxes = client.subscribe('beyondAtcState', ingestState)
    return () => {
      live = false
      unsubscribeBoxes()
    }
  }, [enabled, client])

  // A clearance read before the aircraft's position was known starts from the first position that arrives. Opening Track reads
  // BeyondATC's transcript before Track has loaded the active flight (so no position yet); without this the clearance was stored
  // with nowhere to start, never traced, and fell back to whole taxiways. Updated during render (React's "adjust state when a
  // prop changes" pattern), not in an effect.
  if (clearance && !clearance.from && position) setClearance({ ...clearance, ...startOf(position) })
  // The route held when the takeoff roll starts is the departure's: dropped then, so it can't
  // come back at the arrival. Only on that change, never just for being airborne, so an
  // arrival's taxi clearance is never thrown away even if the phase lags behind touchdown;
  // anything heard while airborne is only hidden until the aircraft is down.
  const departed = isDeparted(phase)
  const [wasDeparted, setWasDeparted] = useState(uiMemory().taxiRoute.departed)
  if (departed !== wasDeparted) {
    setWasDeparted(departed)
    if (departed) setClearance(null)
  }
  useEffect(() => {
    uiMemory().taxiRoute.departed = wasDeparted
    uiMemory().taxiRoute.clearance = clearance
  }, [wasDeparted, clearance])

  const icao = clearance ? clearanceAirport(clearance, depIcao, arrIcao, segmentsByIcao) : null

  const standPosition = useClearanceStand(enabled, clearance, icao)
  const runwayThreshold = useClearanceRunway(enabled, clearance, icao)
  const holdShortRunway = useHoldShortRunway(enabled, clearance, icao)

  const segments = icao ? segmentsByIcao[icao] : undefined
  const tracedClearance = useTracedClearance(clearance, segments, {
    standPosition,
    runwayThreshold,
    holdShortRunway
  })
  const traced: TracedRoute | null = tracedClearance?.route ?? null

  useEffect(() => {
    trackerRef.current = traced ? startTracker(traced) : null
  }, [traced])
  useLogTrace(clearance, tracedClearance, icao)

  useLogUntraced(clearance, traced, icao, segments)

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    if (!enabled || departed) {
      if (createdRef.current) {
        map.setLayoutProperty(HIGHLIGHT_LAYER_ID, 'visibility', 'none')
        showTraceLine(map, 'none')
      }
      return
    }
    ensureLayers(map)
    createdRef.current = true

    const tracker = trackerRef.current
    if (traced && tracker) {
      trackerRef.current = drawTracedLine(
        map,
        tracker,
        position,
        phase,
        segments,
        tracedClearance?.kind ?? 'exact'
      )
      return
    }
    drawWholeTaxiways(map, clearance?.taxiways ?? [], icao)
  }, [
    mapRef,
    mapReady,
    enabled,
    departed,
    clearance,
    traced,
    tracedClearance,
    segments,
    icao,
    position,
    phase
  ])
}
