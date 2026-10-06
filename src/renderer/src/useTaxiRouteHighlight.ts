import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { BeyondAtcInfoBox, BeyondAtcState, BeyondAtcTranscriptEntry, FlightPhase, NavdataStand, NavdataTaxiSegment } from '@shared/ipc'
import { parseAtcTaxiFacts } from '@shared/atc-info-boxes'
import { findStand } from '@shared/stands'
import { parseTaxiHoldShortRunway } from '@shared/taxi-route-parser'
import { rejoinTaxiRoute, remainingRoute, traceTaxiRoute, type TracedRoute } from './taxiRouteTrace'
import { checkDeviation, INITIAL_DEVIATION, reachedEnd, segmentDriven } from './taxiReroute'
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

interface TaxiClearance {
  taxiways: string[]
  holdingPoint: string | null
  /** "taxi to Stand N32 …" → 'N32'; null for a holding-point clearance. */
  stand: string | null
  /** "taxi via C7, Y, F, hold short of runway 07C" → '07C': the route runs along its last
   *  taxiway to the hold short, the same way as a holding point. */
  holdShortRunway: string | null
  /** Where the aircraft was when the clearance arrived — the trace's start. */
  from: { lat: number; lon: number } | null
  /** Its heading then, only if it was already taxiing under its own power (at the stand the
   *  nose points the way it'll be pushed back from, so it says nothing about the way out). */
  headingDeg?: number | null
}

/** "27L" or "09": a `Hold Position` box naming a runway, not a holding point. */
const RUNWAY_IDENT = /^\d{1,2}[LRC]?$/

/**
 * The taxi clearance in BeyondATC's InfoBoxes (flightdeck-backend's
 * docs/plans/beyondatc-infoboxes-first.md): `Taxi Via 1..n`, `Hold Position`, `Taxi to Gate`.
 * Real, 2026-10-05: VHHH "B, B, V, H, J" to J1 and ZJSY "A4, D" to gate 102. Null when the
 * boxes hold no taxi route.
 */
export function boxTaxiClearance(boxes: BeyondAtcInfoBox[]): Omit<TaxiClearance, 'from' | 'headingDeg'> | null {
  const facts = parseAtcTaxiFacts(boxes)
  if (facts.taxiVia.length === 0) return null
  const hold = facts.holdPosition
  const holdIsRunway = hold !== null && RUNWAY_IDENT.test(hold)
  return {
    taxiways: facts.taxiVia,
    holdingPoint: holdIsRunway ? null : hold,
    stand: facts.taxiToGate,
    holdShortRunway: holdIsRunway ? hold : null
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

/**
 * Which airport a clearance is at: a holding point is the departure's, a stand the arrival's.
 * "Hold short of runway" can be either (crossing a runway on the way out, or on the way in as
 * at VHHH), so it's the one whose taxi network is nearest the aircraft; the arrival if
 * neither is loaded yet.
 */
function clearanceAirport(
  clearance: TaxiClearance,
  depIcao: string | null,
  arrIcao: string | null,
  segmentsByIcao: Record<string, NavdataTaxiSegment[]>
): string | null {
  if (clearance.holdingPoint) return depIcao
  if (!clearance.holdShortRunway || !clearance.from) return arrIcao
  const from = clearance.from
  let best: { icao: string; distance: number } | null = null
  for (const icao of [arrIcao, depIcao]) {
    for (const s of (icao && segmentsByIcao[icao]) || []) {
      const distance = Math.hypot(s.startLat - from.lat, (s.startLon - from.lon) * Math.cos((from.lat * Math.PI) / 180))
      if (!best || distance < best.distance) best = { icao: icao!, distance }
    }
  }
  return best?.icao ?? arrIcao
}

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
  /** How far along the traced line the aircraft has got (remainingRoute's `segment`). */
  const progressRef = useRef(0)
  /** The current clearance's re-traced line, once it has been re-routed; null until then. */
  const rerouteRef = useRef<TracedRoute | null>(null)
  const deviationRef = useRef(INITIAL_DEVIATION)
  /** The furthest segment of the cleared (first traced) route driven: a re-route only rejoins
   *  from there on. */
  const drivenRef = useRef(0)
  /** Set once the aircraft reaches the end of the line: the clearance is done. */
  const doneRef = useRef(false)
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
    return traceTaxiRoute({
      segments,
      taxiways: clearance.taxiways,
      holdingPoint: clearance.holdingPoint ?? (clearance.holdShortRunway ? (clearance.taxiways.at(-1) ?? null) : null),
      from: clearance.from,
      stand: standPosition,
      headingDeg: clearance.headingDeg ?? null
    })
  }, [clearance, segments, standPosition])

  useEffect(() => {
    progressRef.current = 0
    rerouteRef.current = null
    deviationRef.current = INITIAL_DEVIATION
    drivenRef.current = 0
    doneRef.current = false
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

    if (traced) {
      const active = rerouteRef.current ?? traced
      let line = active
      if (position) {
        let remaining = remainingRoute(active, position, progressRef.current)
        drivenRef.current = segmentDriven(remainingRoute(traced, position, drivenRef.current), drivenRef.current)
        if (reachedEnd(active, position)) doneRef.current = true
        const { headingDeg, groundSpeedMs } = position
        // Only while taxiing: a pushback drives tail first, so its heading is backwards.
        if (phase === 'taxi' && !doneRef.current && segments && headingDeg !== undefined && groundSpeedMs !== undefined) {
          const check = checkDeviation(deviationRef.current, {
            nowMs: Date.now(),
            distanceM: remaining.distanceM,
            lineBearingDeg: remaining.bearingDeg,
            headingDeg,
            groundSpeedMs
          })
          deviationRef.current = check.state
          if (check.reroute) {
            const rerouted = rejoinTaxiRoute({
              segments,
              route: traced,
              fromSegment: drivenRef.current,
              from: { lat: position.lat, lon: position.lon },
              headingDeg
            })
            if (rerouted) {
              rerouteRef.current = rerouted
              remaining = remainingRoute(rerouted, position, 0)
            }
          }
        }
        progressRef.current = remaining.segment
        line = remaining.line
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

/** A clearance's start: the aircraft's position, and its heading if it's taxiing. */
function startOf(
  position: UseTaxiRouteHighlightArgs['position'],
  phase: FlightPhase | null
): Pick<TaxiClearance, 'from' | 'headingDeg'> {
  if (!position) return { from: null, headingDeg: null }
  return {
    from: { lat: position.lat, lon: position.lon },
    headingDeg: phase === 'taxi' ? (position.headingDeg ?? null) : null
  }
}
