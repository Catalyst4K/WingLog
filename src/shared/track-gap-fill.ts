/**
 * Filling the gaps in a flown track from the flight plan (winglog-backend's docs/plans/track-gap-fill.md).
 *
 * A gap is where the recording stopped and started again: tracking resumed after the app closed, or a long stretch the disk refused
 * to save. The plan is a good stand-in for the missing path when both ends of the gap lie on it, so the stretch between them is the
 * planned route between the two ends. The result is an **estimate** kept apart from the recorded points: nothing here is ever a
 * track point, so phase detection, landing analysis and exports never see it.
 */

import { greatCircleNm } from './geo'

/** The slice of a track point this needs. */
export interface GapFillPoint {
  tsUtc: string
  latitude: number
  longitude: number
  resumeSegment: number
}

/** One estimated stretch: from the last recorded point before a gap to the first after it, along the plan. */
export interface EstimatedStretch {
  /** [lon, lat] pairs, GeoJSON order. */
  coordinates: [number, number][]
  lengthNm: number
  /** The recorded points either side of the gap. */
  fromTsUtc: string
  toTsUtc: string
}

export interface GapFillOptions {
  /** Points further apart in time than this are a gap. */
  gapMinutes: number
  /** Both ends of a gap must be this close to the planned line. */
  toleranceNm: number
  /** The second end must be at least this far ahead of the first along the plan. */
  minForwardNm: number
}

export const DEFAULT_GAP_FILL: GapFillOptions = { gapMinutes: 5, toleranceNm: 80, minForwardNm: 1 }

interface Projection {
  /** Distance along the planned line, in nautical miles. */
  alongNm: number
  /** Distance from the line, in nautical miles. */
  offNm: number
  coordinate: [number, number]
  /** The vertex the projection lies after: the fill continues from the one after it. */
  afterVertex: number
}

/**
 * @param line The planned line, [lon, lat] pairs.
 * @returns The distance along the line to each vertex, in nautical miles.
 */
function cumulativeNm(line: [number, number][]): number[] {
  const cumulative = [0]
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    cumulative.push(cumulative[i - 1] + greatCircleNm({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] }))
  }
  return cumulative
}

/**
 * The nearest point of the planned line to a position, found the way the map draws the line: straight between its vertices in
 * longitude and latitude (longitude scaled by the cosine of the latitude).
 *
 * @param line The planned line.
 * @param cumulative The distance along it to each vertex.
 * @param lat The position's latitude.
 * @param lon The position's longitude.
 * @returns The projection.
 */
function project(line: [number, number][], cumulative: number[], lat: number, lon: number): Projection {
  let best: Projection | null = null
  for (let i = 1; i < line.length; i++) {
    const [aLon, aLat] = line[i - 1]
    const [bLon, bLat] = line[i]
    const scale = Math.cos((((aLat + bLat) / 2) * Math.PI) / 180)
    const dx = (bLon - aLon) * scale
    const dy = bLat - aLat
    const lengthSquared = dx * dx + dy * dy
    const t =
      lengthSquared === 0
        ? 0
        : Math.min(1, Math.max(0, ((lon - aLon) * scale * dx + (lat - aLat) * dy) / lengthSquared))
    const coordinate: [number, number] = [aLon + (bLon - aLon) * t, aLat + (bLat - aLat) * t]
    const offNm = greatCircleNm({ lat, lon }, { lat: coordinate[1], lon: coordinate[0] })
    if (best === null || offNm < best.offNm) {
      best = {
        alongNm: cumulative[i - 1] + (cumulative[i] - cumulative[i - 1]) * t,
        offNm,
        coordinate,
        afterVertex: i - 1
      }
    }
  }
  return best ?? { alongNm: 0, offNm: Number.POSITIVE_INFINITY, coordinate: [lon, lat], afterVertex: 0 }
}

/**
 * @param coordinates A path, [lon, lat] pairs.
 * @returns Its length in nautical miles.
 */
export function pathLengthNm(coordinates: [number, number][]): number {
  let total = 0
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1]
    const b = coordinates[i]
    total += greatCircleNm({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] })
  }
  return total
}

/**
 * Estimates the path through each gap in a track, along the planned route.
 *
 * @param points The flight's recorded points, in order (the visible ones: excluded points are not part of the track).
 * @param route The planned route, [lon, lat] pairs; an OFP-less flight has none and gets no estimate.
 * @param options What counts as a gap and how far from the plan a gap may be.
 * @returns The estimated stretches, in flight order. Empty when there is no gap, no plan, or no gap that lies along the plan.
 */
export function fillTrackGaps(
  points: GapFillPoint[],
  route: [number, number][],
  options: GapFillOptions = DEFAULT_GAP_FILL
): EstimatedStretch[] {
  if (route.length < 2 || points.length < 2) return []
  const cumulative = cumulativeNm(route)
  const stretches: EstimatedStretch[] = []
  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1]
    const after = points[i]
    const minutes = (Date.parse(after.tsUtc) - Date.parse(before.tsUtc)) / 60_000
    if (!(minutes > options.gapMinutes) && before.resumeSegment === after.resumeSegment) continue
    if (!(minutes > 0)) continue
    const from = project(route, cumulative, before.latitude, before.longitude)
    const to = project(route, cumulative, after.latitude, after.longitude)
    if (from.offNm > options.toleranceNm || to.offNm > options.toleranceNm) continue
    if (to.alongNm - from.alongNm < options.minForwardNm) continue
    const coordinates: [number, number][] = [
      [before.longitude, before.latitude],
      from.coordinate,
      ...route.slice(from.afterVertex + 1, to.afterVertex + 1),
      to.coordinate,
      [after.longitude, after.latitude]
    ]
    stretches.push({
      coordinates,
      lengthNm: pathLengthNm(coordinates),
      fromTsUtc: before.tsUtc,
      toTsUtc: after.tsUtc
    })
  }
  return stretches
}

/** What "Fill gaps from the flight plan" did. */
export interface TrackEstimateResult {
  /** 'noRoute': the flight has no planned route to follow. 'noGaps': nothing to fill, or no gap along the plan. */
  outcome: 'filled' | 'noGaps' | 'noRoute'
  count: number
  lengthNm: number
}

/**
 * @param stretches Estimated stretches.
 * @returns Their total length in nautical miles.
 */
export function estimatedLengthNm(stretches: EstimatedStretch[]): number {
  return stretches.reduce((sum, s) => sum + s.lengthNm, 0)
}

/**
 * Reads stored estimated stretches, checking every field: a synced row or an old build's data is not trusted to be well formed.
 *
 * @param json The stored JSON, or null.
 * @returns The stretches, or an empty list for anything missing or malformed.
 */
export function parseEstimatedStretches(json: string | null): EstimatedStretch[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    const out: EstimatedStretch[] = []
    for (const item of parsed as Record<string, unknown>[]) {
      const coords = item?.coordinates
      if (!Array.isArray(coords) || coords.length < 2 || typeof item.lengthNm !== 'number') continue
      const valid = coords.every(
        (c) =>
          Array.isArray(c) &&
          c.length === 2 &&
          Number.isFinite(c[0]) &&
          Number.isFinite(c[1]) &&
          Math.abs(c[0] as number) <= 180 &&
          Math.abs(c[1] as number) <= 90
      )
      if (!valid || !Number.isFinite(item.lengthNm)) continue
      out.push({
        coordinates: coords as [number, number][],
        lengthNm: item.lengthNm,
        fromTsUtc: typeof item.fromTsUtc === 'string' ? item.fromTsUtc : '',
        toTsUtc: typeof item.toTsUtc === 'string' ? item.toTsUtc : ''
      })
    }
    return out
  } catch {
    return []
  }
}
