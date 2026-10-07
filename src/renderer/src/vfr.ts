/**
 * Pure geometry for the Track map's VFR overlay (winglog-backend docs/plans/
 * map-language-and-declutter.md, Part C items 1-3): range rings, a "recent track" emphasis
 * and the nearest-airfield readout. No map, no DOM — FlightMap's `useVfrOverlay` feeds
 * these into GeoJSON sources.
 */

import type { Airfield, TrackPoint } from '@shared/ipc'
import { destinationPoint, greatCircleNm, initialBearingDeg, METRES_PER_NM } from '@shared/geo'

const RAD = Math.PI / 180

/** Ring radii drawn around the aircraft. */
export const RANGE_RING_RADII_NM = [5, 10, 20] as const

/** How much of the flown track is emphasised — circuits and pattern work read at a glance. */
export const RECENT_TRAIL_MINUTES = 10

/**
 * Great-circle destination point [lon, lat]. Longitude is left unwrapped, so a ring that
 * crosses the antimeridian stays continuous for the renderer instead of jumping across.
 *
 * @param lat Start latitude.
 * @param lon Start longitude.
 * @param bearing Bearing, degrees true.
 * @param distanceNm Distance, nautical miles.
 * @returns The point, [lon, lat].
 */
export function destinationLonLat(lat: number, lon: number, bearing: number, distanceNm: number): [number, number] {
  const to = destinationPoint({ lat, lon }, bearing, distanceNm * METRES_PER_NM)
  return [to.lon, to.lat]
}

export interface RingFeatureCollection {
  type: 'FeatureCollection'
  features: (
    | {
        type: 'Feature'
        properties: { radiusNm: number }
        geometry: { type: 'LineString'; coordinates: [number, number][] }
      }
    | {
        type: 'Feature'
        properties: { radiusNm: number; label: string }
        geometry: { type: 'Point'; coordinates: [number, number] }
      }
  )[]
}

/**
 * A closed circle of `steps` segments at `radiusNm` around the given position.
 *
 * @param lat Centre latitude.
 * @param lon Centre longitude.
 * @param radiusNm Radius, nautical miles.
 * @param steps How many segments.
 * @returns The circle's points, closed.
 */
export function circleCoordinates(
  lat: number,
  lon: number,
  radiusNm: number,
  steps = 72
): [number, number][] {
  const ring: [number, number][] = []
  for (let i = 0; i < steps; i++) ring.push(destinationLonLat(lat, lon, (i * 360) / steps, radiusNm))
  ring.push(ring[0]!)
  return ring
}

/**
 * One line per ring plus a label point at the ring's northern edge; empty with no position.
 *
 * @param position The aircraft's position, or null.
 * @returns The rings and their labels.
 */
export function rangeRingFeatures(
  position: { latitude: number; longitude: number } | null
): RingFeatureCollection {
  if (!position) return { type: 'FeatureCollection', features: [] }
  const features: RingFeatureCollection['features'] = []
  for (const radiusNm of RANGE_RING_RADII_NM) {
    features.push({
      type: 'Feature',
      properties: { radiusNm },
      geometry: {
        type: 'LineString',
        coordinates: circleCoordinates(position.latitude, position.longitude, radiusNm)
      }
    })
    features.push({
      type: 'Feature',
      properties: { radiusNm, label: `${radiusNm} nm` },
      geometry: {
        type: 'Point',
        coordinates: destinationLonLat(position.latitude, position.longitude, 0, radiusNm)
      }
    })
  }
  return { type: 'FeatureCollection', features }
}

/**
 * The last `minutes` of the flown track as line segments (split wherever a resume gap
 * starts a new segment, so a restart never draws a straight line across the gap). "Now" is
 * the newest point's own timestamp rather than the wall clock — correct while the sim is
 * paused, when a replay runs faster than real time, and for a finished flight.
 *
 * @param points The flight's track points.
 * @param minutes How far back.
 * @returns The segments' [lon, lat] points.
 */
export function recentTrailSegments(
  points: TrackPoint[],
  minutes = RECENT_TRAIL_MINUTES
): [number, number][][] {
  const last = points[points.length - 1]
  if (!last) return []
  const cutoff = Date.parse(last.tsUtc) - minutes * 60_000
  if (Number.isNaN(cutoff)) return []

  const segments: [number, number][][] = []
  let current: [number, number][] = []
  let currentSegment: number | null = null
  for (const p of points) {
    if (Date.parse(p.tsUtc) < cutoff) continue
    if (currentSegment !== null && p.resumeSegment !== currentSegment && current.length > 0) {
      segments.push(current)
      current = []
    }
    currentSegment = p.resumeSegment
    current.push([p.longitude, p.latitude])
  }
  if (current.length > 0) segments.push(current)
  // A single point isn't a line.
  return segments.filter((s) => s.length >= 2)
}

export interface NearestAirfield {
  airfield: Airfield
  distanceNm: number
  bearingDeg: number
}

/** Heliports and seaplane bases aren't somewhere a fixed-wing VFR pilot diverts to. */
const NEAREST_TYPES: ReadonlySet<string> = new Set(['large_airport', 'medium_airport', 'small_airport'])

/**
 * The nearest airfield a fixed-wing aircraft could land at. A cheap flat-earth squared
 * distance picks the candidate across ~43k rows (this runs on every telemetry tick); only
 * the winner gets the exact great-circle figure. Longitude difference is wrapped so a
 * position near the antimeridian still finds a neighbour on the other side.
 *
 * @param lat Latitude.
 * @param lon Longitude.
 * @param airfields Every airfield.
 * @returns The nearest, with its distance and bearing, or null.
 */
export function nearestAirfield(lat: number, lon: number, airfields: Airfield[]): NearestAirfield | null {
  const cosLat = Math.cos(lat * RAD)
  let best: Airfield | null = null
  let bestScore = Infinity
  for (const a of airfields) {
    if (!NEAREST_TYPES.has(a.type)) continue
    const dLat = a.latitude - lat
    let dLon = a.longitude - lon
    if (dLon > 180) dLon -= 360
    else if (dLon < -180) dLon += 360
    const score = dLat * dLat + dLon * cosLat * (dLon * cosLat)
    if (score < bestScore) {
      bestScore = score
      best = a
    }
  }
  if (!best) return null
  return {
    airfield: best,
    distanceNm: greatCircleNm({ lat, lon }, { lat: best.latitude, lon: best.longitude }),
    bearingDeg: initialBearingDeg({ lat, lon }, { lat: best.latitude, lon: best.longitude })
  }
}

/**
 * "EGLL Heathrow · 12.3 nm · 270°" — one decimal under 10 nm, whole numbers above.
 *
 * @param n The nearest airfield.
 * @returns The readout text.
 */
export function formatNearest(n: NearestAirfield): string {
  const distance = n.distanceNm < 10 ? n.distanceNm.toFixed(1) : String(Math.round(n.distanceNm))
  const bearing = String(Math.round(n.bearingDeg) % 360).padStart(3, '0')
  return `${n.airfield.icao}${n.airfield.name ? ` ${n.airfield.name}` : ''} · ${distance} nm · ${bearing}°`
}

/**
 * GeoJSON for the airfields source — properties are only what the layers need.
 *
 * @param airfields Every airfield.
 * @returns The GeoJSON.
 */
export function airfieldFeatureCollection(airfields: Airfield[]): {
  type: 'FeatureCollection'
  features: {
    type: 'Feature'
    properties: { icao: string; name: string; type: string }
    geometry: { type: 'Point'; coordinates: [number, number] }
  }[]
} {
  return {
    type: 'FeatureCollection',
    features: airfields.map((a) => ({
      type: 'Feature' as const,
      properties: { icao: a.icao, name: a.name, type: a.type },
      geometry: { type: 'Point' as const, coordinates: [a.longitude, a.latitude] as [number, number] }
    }))
  }
}
