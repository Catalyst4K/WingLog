import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { BeyondAtcState, BeyondAtcTranscriptEntry, FlightPhase, NavdataStand, NavdataTaxiSegment } from '@shared/ipc'
import { findStand } from '@shared/stands'
import { parseTaxiHoldShortRunway } from '@shared/taxi-route-parser'
import type { TracedRoute } from './taxiRouteTrace'
import { boxTaxiClearance, clearanceAirport, startOf, traceClearance, type TaxiClearance } from './taxi-clearance'
import { startTracker, trackPosition, type RerouteTracker } from './taxiReroute'
import { diagMap } from './diag'
import { TAXI_SOURCE_ID } from './useTaxiChartOverlay'
import { useLiveClient } from './live/LiveClient'

/**
 * Highlights BeyondATC's most recent live taxi clearance on top of the taxi chart overlay
 * (flightdeck-backend's docs/plans/beyondatc-taxi-route-highlight.md — the ATC-driven route
 * half of Part 4, built on top of Part 4a's static chart).
 *
 * Preferred: the route actually traced through the taxi network (taxiRouteTrace.ts), from
 * where the aircraft was when the clearance arrived to the holding point (or, for a stand,
 * to where it joins the last cleared taxiway), drawn as its own line starting at the aircraft
 * and shortening as it taxis (remainingRoute). Real bug that prompted it, VHHH 2026-09-30:
 * the v1 behaviour below lit up all of taxiway B across the airport for a short hop via B8, B
 * to B10.
 *
 * Fallback, whenever a trace isn't possible (the holding point isn't in the data, no live
 * position, aircraft off the network): v1's second `line` layer on the same `taxi-chart`
 * source, filtered to every segment sharing a cleared taxiway name.
 *
 * The clearance comes only from BeyondATC's InfoBoxes (`Taxi Via 1..n`, `Hold Position`,
 * `Taxi to Gate`; boxTaxiClearance), never from parsing the speech (flightdeck-backend's
 * docs/decisions.md, 2026-10-05). The one exception is a spoken "hold short of runway 07C",
 * which has no box: it's added to the box route heard within HOLD_SHORT_PAIR_MS of it.
 *
 * Re-routing (flightdeck-backend's docs/plans/taxi-reroute.md): when the aircraft leaves the
 * line, or drives the wrong way along it, while taxiing, the line is redrawn as the shortest
 * way from where it is to the same end, rejoining the cleared route wherever that's shortest
 * (taxiReroute.ts decides when, rejoinTaxiRoute where). A re-route that can't be traced (off the
 * network) keeps the line it had. Once the aircraft reaches the end, nothing re-routes.
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

/** How close a spoken "hold short of runway" must be to a box route to belong to it: BeyondATC
 *  updates the boxes and speaks within a second or two of each other. */
const HOLD_SHORT_PAIR_MS = 30_000

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

/** From the takeoff roll until touchdown the departure's taxi route is finished with: it used
 *  to stay drawn on top of the flown track at every zoom (real report, 2026-10-05). Landing
 *  isn't in here, so an arrival's "taxi to stand" clearance still draws after touchdown. */
const DEPARTED_PHASES: ReadonlySet<FlightPhase> = new Set(['takeoff', 'climb', 'cruise', 'descent'])

/** Survives a FlightMap remount the same way useTaxiChartOverlay's rememberedEnabled does —
 *  a route parsed before a tab switch shouldn't just vanish on return. Cleared only by a
 *  genuinely new clearance, never automatically. */
let rememberedClearance: TaxiClearance | null = null
/** The newest transcript line already looked at — module-level for the same reason, so coming
 *  back to Track doesn't re-read old clearances as new ones. */
let rememberedLastTs = 0
/** Whether the aircraft was last seen past the takeoff roll — module-level so leaving Track
 *  at the holding point and coming back in cruise still drops the departure's route. */
let rememberedDeparted = false
/** The last InfoBoxes taxi clearance already taken, and when, so the same boxes aren't taken
 *  again (on remount, or still showing after the takeoff roll dropped the route). */
let rememberedBoxKey = ''
let rememberedBoxAt = 0
/** The last spoken hold-short runway and when, for a box route that arrives just after it. */
let rememberedHoldShort: { runway: string; at: number } | null = null

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
  const [clearance, setClearance] = useState<TaxiClearance | null>(rememberedClearance)
  const client = useLiveClient()
  const positionRef = useRef(position)
  const phaseRef = useRef(phase)
  /** The current clearance's line between position updates (taxiReroute.ts). */
  const trackerRef = useRef<RerouteTracker | null>(null)
  // Whether this hook has itself created its layers. Checked instead of calling
  // map.getLayer() unconditionally on every mount (App.tsx/LogbookView.tsx's own FlightMap
  // hosts use a simpler test fake that doesn't implement getLayer, since nothing needed it
  // there before — this hook must never touch it while the base chart has never been on).
  const createdRef = useRef(false)

  useEffect(() => {
    positionRef.current = position
    phaseRef.current = phase
  }, [position, phase])

  // Gated on `enabled` — same "nothing happens until the chart is switched on" discipline
  // useTaxiChartOverlay's own fetch effect follows. The boxes and transcript BeyondATC already
  // has are read straight away, not just the next push: a clearance given while Track wasn't
  // open used to wait for ATC's next line before it was drawn (YBBN, 2026-10-02).
  useEffect(() => {
    if (!enabled) return
    let live = true
    const withHoldShort = (clearance: TaxiClearance, runway: string): TaxiClearance =>
      clearance.holdShortRunway ? clearance : { ...clearance, holdShortRunway: runway }
    // ATC's speech: only "hold short of runway …", which has no box.
    const ingest = (transcript: BeyondAtcTranscriptEntry[]): void => {
      if (!live) return
      for (const entry of transcript) {
        if (entry.speaker !== 'atc' || entry.ts <= rememberedLastTs) continue
        rememberedLastTs = entry.ts
        const runway = parseTaxiHoldShortRunway(entry.text)
        if (!runway) continue
        rememberedHoldShort = { runway, at: Date.now() }
        if (rememberedClearance && Date.now() - rememberedBoxAt <= HOLD_SHORT_PAIR_MS) {
          rememberedClearance = withHoldShort(rememberedClearance, runway)
          setClearance(rememberedClearance)
        }
      }
    }
    // The clearance itself, taken once per new set of taxi boxes.
    const ingestBoxes = (state: BeyondAtcState): void => {
      if (!live) return
      const box = boxTaxiClearance(state.infoBoxes)
      if (!box) return
      const key = JSON.stringify(box)
      if (key === rememberedBoxKey) return
      rememberedBoxKey = key
      rememberedBoxAt = Date.now()
      let next: TaxiClearance = { ...box, ...startOf(positionRef.current, phaseRef.current) }
      if (rememberedHoldShort && Date.now() - rememberedHoldShort.at <= HOLD_SHORT_PAIR_MS) {
        next = withHoldShort(next, rememberedHoldShort.runway)
      }
      rememberedClearance = next
      setClearance(next)
    }
    window.winglog.beyondAtcGetTranscript().then(ingest, () => undefined)
    const unsubscribe = window.winglog.onBeyondAtcTranscript(ingest)
    client.get('beyondAtcState').then((state) => state && ingestBoxes(state), () => undefined)
    const unsubscribeBoxes = client.subscribe('beyondAtcState', ingestBoxes)
    return () => {
      live = false
      unsubscribe()
      unsubscribeBoxes()
    }
  }, [enabled, client])

  // A clearance read before the aircraft's position was known starts from the first position
  // that arrives. Real bug, ZSPD 2026-10-02: opening Track reads BeyondATC's transcript before
  // Track has loaded the active flight (so no position yet) — the clearance was stored with
  // nowhere to start, never traced, and fell back to whole taxiways. Updated during render
  // (React's "adjust state when a prop changes" pattern), not in an effect.
  if (clearance && !clearance.from && position) setClearance({ ...clearance, ...startOf(position, phase) })
  // The route held when the takeoff roll starts is the departure's: dropped then, so it can't
  // come back at the arrival. Only on that change, never just for being airborne, so an
  // arrival's taxi clearance is never thrown away even if the phase lags behind touchdown;
  // anything heard while airborne is only hidden until the aircraft is down.
  const departed = phase !== null && DEPARTED_PHASES.has(phase)
  const [wasDeparted, setWasDeparted] = useState(rememberedDeparted)
  if (departed !== wasDeparted) {
    setWasDeparted(departed)
    if (departed) setClearance(null)
  }
  useEffect(() => {
    rememberedDeparted = wasDeparted
  }, [wasDeparted])
  useEffect(() => {
    rememberedClearance = clearance
  }, [clearance])

  const icao = clearance ? clearanceAirport(clearance, depIcao, arrIcao, segmentsByIcao) : null

  // The arrival airport's stands, once a stand clearance needs one (fetched from the sim on
  // first ask, then cached — stand-positions.md).
  const [stands, setStands] = useState<{ icao: string; list: NavdataStand[] } | null>(null)
  const standIcao = enabled && clearance?.stand && icao ? icao : null
  useEffect(() => {
    if (!standIcao) return
    let ignore = false
    window.winglog.navdataGetStands(standIcao).then(
      (list) => {
        if (!ignore) setStands({ icao: standIcao, list })
      },
      () => undefined
    )
    return () => {
      ignore = true
    }
  }, [standIcao])
  const standPosition =
    clearance?.stand && stands && stands.icao === icao ? findStand(stands.list, clearance.stand) : null

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
      let line = tracker.active
      if (position) {
        const update = trackPosition(tracker, { position, phase, nowMs: Date.now(), segments })
        trackerRef.current = update.tracker
        if (update.rerouted) {
          diagMap('taxi route re-routed', { at: position, points: update.tracker.active.length, end: update.tracker.active.at(-1) })
        }
        line = update.line
      }
      map.getSource<GeoJSONSource>(TRACE_SOURCE_ID)?.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: line }
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
  }, [mapRef, mapReady, enabled, departed, clearance, traced, segments, icao, position, phase])
}
