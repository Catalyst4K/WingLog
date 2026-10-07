/**
 * What a Logbook flight's detail page derives from the flight: its recorded track, the route
 * shown on the map, and the altitude and speed profile for the charts. FlightDetail calls
 * these in this order.
 */

import { winglogApi } from '../data/winglog-api'
import { useEffect, useMemo, useState } from 'react'
import type { Flight, TrackPoint } from '@shared/ipc'
import { computeChartAxisTicks, formatTickLabel } from '../chart-ticks'
import { displayAltitude } from '../display-altitude'
import { selectionFromFlight, useLiveWaypoints } from '../procedure-selection'
import { runAsync } from '../report-error'
import { parseTransitionAltitudes, type Waypoint } from '../route'
import { msToKt } from '../units'

// Past this, a minutes axis on a long-haul chart reads as a wall of three-digit ticks
// (e.g. "540 min") — hours read at a glance instead. Below it, a short flight's duration
// in hours would round to one or two ticks total, which is worse than minutes, not better.
const HOURS_AXIS_THRESHOLD_MIN = 90

/**
 * Loads the flight's recorded track.
 *
 * @param flightId The flight.
 * @returns The track points, and a setter for when the track is cleaned up.
 */
export function useFlightTrack(flightId: number): {
  trackPoints: TrackPoint[]
  setTrackPoints: (points: TrackPoint[]) => void
} {
  const [trackPoints, setTrackPoints] = useState<TrackPoint[]>([])
  useEffect(() => {
    runAsync('LogbookView trackPointList', winglogApi().trackPointList(flightId).then(setTrackPoints))
  }, [flightId])
  return { trackPoints, setTrackPoints }
}

/** The route and waypoints the map draws for a flight. */
export interface FlightRoute {
  displayRoute: [number, number][]
  displayWaypoints: Waypoint[]
  /** True when the route is a synthesised great-circle line rather than the flight's own. */
  routeIsApproximate: boolean
}

/**
 * The route for the map: the flight's own (its OFP with the persisted procedure selection
 * spliced in), or — for a flight with no OFP route — a synthesised great-circle line between
 * its airports.
 *
 * @param flight The flight.
 * @returns The route, its waypoints, and whether it's approximate.
 */
export function useFlightRoute(flight: Flight): FlightRoute {
  // The persisted selection (Track's live edits at flight completion) if this flight ever
  // had one, else all-null — which reduces to exactly the old OFP-only rendering (Phase 5,
  // docs/plans/navdata-without-navigraph.md). Shows what was actually flown, not just what
  // SimBrief originally planned.
  const waypoints = useLiveWaypoints(flight, selectionFromFlight(flight))
  const route: [number, number][] = useMemo(() => waypoints.map((w) => [w.lon, w.lat]), [waypoints])

  // Fallback for a flight with no OFP-derived route (any CSV-imported historical flight,
  // or one started directly from Track — docs/plans/great-circle-fallback-route.md): fetch
  // a synthesized great-circle line only when the synchronous OFP parse above came back
  // empty, so a flight that does have a real route never pays for this round trip.
  const [fallbackRoute, setFallbackRoute] = useState<[number, number][]>([])
  useEffect(() => {
    if (route.length > 0) return
    let cancelled = false
    runAsync(
      'LogbookView logbookGreatCircleRoute',
      winglogApi()
        .logbookGreatCircleRoute(flight.depIcao, flight.arrIcao)
        .then((points) => {
          if (!cancelled) setFallbackRoute(points ?? [])
        })
    )
    return () => {
      cancelled = true
    }
  }, [route, flight.depIcao, flight.arrIcao])

  const routeIsApproximate = route.length === 0 && fallbackRoute.length > 0
  const displayRoute = route.length > 0 ? route : fallbackRoute
  const displayWaypoints: Waypoint[] = useMemo(() => {
    if (route.length > 0) return waypoints
    if (fallbackRoute.length === 0) return []
    const [depLon, depLat] = fallbackRoute[0]
    const [arrLon, arrLat] = fallbackRoute[fallbackRoute.length - 1]
    return [
      { ident: flight.depIcao, lon: depLon, lat: depLat, altitudeFt: 0, segment: 'enroute' },
      { ident: flight.arrIcao, lon: arrLon, lat: arrLat, altitudeFt: 0, segment: 'enroute' }
    ]
  }, [route, waypoints, fallbackRoute, flight.depIcao, flight.arrIcao])

  return { displayRoute, displayWaypoints, routeIsApproximate }
}

/** One charted sample: elapsed minutes, altitude, indicated airspeed and Mach. */
export interface ProfilePoint {
  tMin: number
  altFt: number
  altLabel: string
  iasKt: number
  mach: number
}

/** What the altitude and speed charts plot, and how their shared time axis reads. */
export interface FlightProfile {
  profile: ProfilePoint[]
  /** "True altitude" for a flight with no pressure-altitude data, else the PFD-style label. */
  altitudeChartLabel: string
  ticksMin: number[]
  timeAxisUnit: string
  formatTimeTick: (value: number) => string
}

/**
 * Turns the track into chart data, and picks the time axis (minutes, or hours for a long-haul).
 *
 * @param ofpJson The flight's OFP, for its transition altitude and level (null when it has none).
 * @param trackPoints The flight's recorded track.
 * @returns The profile and the time axis.
 */
export function useFlightProfile(ofpJson: string | null, trackPoints: TrackPoint[]): FlightProfile {
  // The origin's transition altitude / destination's transition level, for the altitude
  // chart below (docs/plans/logbook-detail-improvements.md, Phase 3) — null for a flight
  // with no OFP, or an older/malformed one; display-altitude.ts falls back to a fixed
  // 18,000 ft both ways in that case.
  const transition = useMemo(() => parseTransitionAltitudes(ofpJson), [ofpJson])

  // Elapsed minutes since the first sample reads better on a chart than raw timestamps.
  // Memoized like route/waypoints above — trackPoints only actually changes once, when
  // the fetch above resolves, so recomputing this on every unrelated re-render was pure
  // waste (previously not memoized at all, unlike its siblings here).
  const profile = useMemo(() => {
    const startMs = trackPoints.length ? new Date(trackPoints[0].tsUtc).getTime() : 0
    return trackPoints.map((p) => {
      // Left unrounded — track points aren't evenly spaced in time (FlightRecorder samples
      // 1-5s depending on phase, then track-simplify.ts's Douglas-Peucker pass keeps more
      // points where the profile bends), so a real `type="number"` time axis needs each
      // point's true elapsed time to plot the chart's actual shape, not just to label it
      // (docs/plans/logbook-detail-improvements.md, item 1).
      const tMin = (new Date(p.tsUtc).getTime() - startMs) / 60000
      // Pressure altitude above the transition, true altitude below it — what the aircraft's
      // own PFD actually showed (Phase 3), not always true/geometric altitude as before.
      const alt = displayAltitude(
        { altitudeM: p.altitudeM, pressureAltitudeM: p.pressureAltitudeM, phase: p.phase },
        transition
      )
      return {
        tMin,
        altFt: Math.round(alt.valueFt),
        altLabel: alt.label,
        iasKt: Math.round(msToKt(p.indicatedAirspeedMs)),
        mach: Math.round(p.machSpeed * 100) / 100
      }
    })
  }, [trackPoints, transition])

  // A flight with no pressure-altitude data at all (recorded before Phase 3 shipped) keeps
  // showing true altitude throughout — labelled as such so the mismatch this whole plan
  // exists to fix isn't re-reported as a new bug against old data.
  const altitudeChartLabel = profile.at(-1)?.altLabel ?? 'Altitude'

  // A long-haul's duration reads better in hours than as a three/four-digit minutes axis
  // — see HOURS_AXIS_THRESHOLD_MIN above. Both charts share the same `tMin` data field
  // regardless: this only changes which tick ladder/label unit is used, not the axis's own
  // domain, so climb/cruise/descent stay proportional to real elapsed time either way.
  const durationMin = profile.at(-1)?.tMin ?? 0
  const useHoursAxis = durationMin > HOURS_AXIS_THRESHOLD_MIN
  const { ticksMin } = useMemo(
    () => computeChartAxisTicks(durationMin, useHoursAxis),
    [durationMin, useHoursAxis]
  )
  const timeAxisUnit = useHoursAxis ? ' hr' : ' min'
  const formatTimeTick = (value: number): string =>
    useHoursAxis ? formatTickLabel(value / 60) : formatTickLabel(value)

  return { profile, altitudeChartLabel, ticksMin, timeAxisUnit, formatTimeTick }
}
