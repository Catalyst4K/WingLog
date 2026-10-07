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
 * The clearance comes only from BeyondATC's InfoBoxes (`Taxi Via 1..n`, `Hold Position`, `Taxi to Gate`; boxTaxiClearance),
 * never from parsing the speech (winglog-backend's docs/decisions.md, 2026-10-05). The one exception is a spoken "hold short
 * of runway 07C", which has no box: it's added to the box route heard within HOLD_SHORT_PAIR_MS of it.
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
import type {
  BeyondAtcState,
  BeyondAtcTranscriptEntry,
  FlightPhase,
  NavdataStand,
  NavdataTaxiSegment
} from '@shared/ipc'
import { findStand } from '@shared/stands'
import type { TracedRoute } from './taxi-route-trace'
import { clearanceAirport, startOf, traceClearance, type TaxiClearance } from './taxi-clearance'
import { startTracker, trackPosition, type RerouteTracker } from './taxi-reroute'
import { isDeparted, stepTaxiBoxes, stepTaxiTranscript } from './taxi-clearance-step'
import { diagMap } from './diag'
import { setSourceData } from './map-source'
import { TAXI_SOURCE_ID } from './use-taxi-chart-overlay'
import { useLiveClient } from './live/LiveClient'
import { uiMemory } from './ui-memory'

const HIGHLIGHT_LAYER_ID = 'taxi-chart-route-highlight'
const TRACE_SOURCE_ID = 'taxi-route-trace'
const TRACE_LAYER_ID = 'taxi-route-trace-line'

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
  }
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
 * Takes the spoken part of ATC's clearance (the hold short) into the remembered state.
 *
 * @param transcript BeyondATC's transcript.
 * @param setClearance Sets the hook's clearance.
 */
function ingestTranscript(
  transcript: BeyondAtcTranscriptEntry[],
  setClearance: (clearance: TaxiClearance) => void
): void {
  const result = stepTaxiTranscript(uiMemory().taxiRoute, transcript, Date.now())
  uiMemory().taxiRoute = result.memory
  if (result.clearance) setClearance(result.clearance)
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
 * Draws the traced line from the aircraft, re-routing first if it has left the line.
 *
 * @param map The map.
 * @param tracker The clearance's tracker.
 * @param position The aircraft's position, or null.
 * @param phase The flight phase, or null.
 * @param segments The airport's taxi network.
 * @returns The tracker after this update.
 */
function drawTracedLine(
  map: MapLibreMap,
  tracker: RerouteTracker,
  position: UseTaxiRouteHighlightArgs['position'],
  phase: FlightPhase | null,
  segments: NavdataTaxiSegment[] | undefined
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
  map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', 'visible')
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
  map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', 'none')
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

  // Gated on `enabled`: nothing happens until the chart is switched on, as in useTaxiChartOverlay's fetch effect. The boxes and
  // transcript BeyondATC already has are read straight away, not just on the next push, so a clearance given while Track wasn't
  // open isn't left waiting for ATC's next line.
  useEffect(() => {
    if (!enabled) return
    let live = true
    const ingest = (transcript: BeyondAtcTranscriptEntry[]): void => {
      if (live) ingestTranscript(transcript, setClearance)
    }
    const ingestState = (state: BeyondAtcState): void => {
      if (live) ingestBoxes(state, positionRef.current, setClearance)
    }
    // A failed first read (BeyondATC not connected) has nothing to show; the subscriptions bring
    // the next update.
    winglogApi()
      .beyondAtcGetTranscript()
      .then(ingest, () => undefined)
    const unsubscribe = winglogApi().onBeyondAtcTranscript(ingest)
    client.get('beyondAtcState').then(
      (state) => state && ingestState(state),
      () => undefined
    )
    const unsubscribeBoxes = client.subscribe('beyondAtcState', ingestState)
    return () => {
      live = false
      unsubscribe()
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
  }, [wasDeparted])
  useEffect(() => {
    uiMemory().taxiRoute.clearance = clearance
  }, [clearance])

  const icao = clearance ? clearanceAirport(clearance, depIcao, arrIcao, segmentsByIcao) : null

  const standPosition = useClearanceStand(enabled, clearance, icao)

  const segments = icao ? segmentsByIcao[icao] : undefined
  // Re-traced when segments finish loading too — a clearance can arrive before the chart has.
  const traced: TracedRoute | null = useMemo(() => {
    if (!clearance?.from || !segments || segments.length === 0) return null
    return traceClearance(clearance, segments, standPosition)
  }, [clearance, segments, standPosition])

  useEffect(() => {
    trackerRef.current = traced ? startTracker(traced) : null
    if (clearance) {
      diagMap(traced ? 'taxi route traced' : 'taxi route not traced: whole taxiways instead', {
        icao,
        taxiways: clearance.taxiways,
        holdingPoint: clearance.holdingPoint,
        stand: clearance.stand,
        holdShortRunway: clearance.holdShortRunway,
        from: clearance.from,
        points: traced?.length ?? 0,
        end: traced?.at(-1) ?? null
      })
    }
    // Logged once per new trace, not when the clearance object alone changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearance/icao are read only to describe this trace
  }, [traced])

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    if (!enabled || departed) {
      if (createdRef.current) {
        map.setLayoutProperty(HIGHLIGHT_LAYER_ID, 'visibility', 'none')
        map.setLayoutProperty(TRACE_LAYER_ID, 'visibility', 'none')
      }
      return
    }
    ensureLayers(map)
    createdRef.current = true

    const tracker = trackerRef.current
    if (traced && tracker) {
      trackerRef.current = drawTracedLine(map, tracker, position, phase, segments)
      return
    }
    drawWholeTaxiways(map, clearance?.taxiways ?? [], icao)
  }, [mapRef, mapReady, enabled, departed, clearance, traced, segments, icao, position, phase])
}
