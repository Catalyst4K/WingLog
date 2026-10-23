/**
 * How well one taxi line lies on another, as taxi-score (a recorded taxi) and taxi-generated (a sampled route) both measure it: the share of
 * a line within ON_M of the other, checked every STEP_M along it.
 */
import { toLocalXy } from '../../src/shared/geo'
import { pointsAlong, type Xy } from '../../src/shared/taxi/route-checks'
import type { LonLat } from './svg'

/** A point is "on" a line when it is within this many metres of it. */
export const ON_M = 25
/** A line is checked every this many metres. */
export const STEP_M = 5

/**
 * @param p A point, in metres.
 * @param line A line, in metres.
 * @returns How far the point is from the line.
 */
export function distToPolyline(p: Xy, line: Xy[]): number {
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1]
    const [bx, by] = line[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2))
    best = Math.min(best, Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]))
  }
  return line.length === 1 ? Math.hypot(line[0][0] - p[0], line[0][1] - p[1]) : best
}

/**
 * @param points A line, [lon, lat].
 * @param refLatDeg The latitude the plane is scaled at.
 * @returns The line in metres on a flat plane.
 */
export function flat(points: LonLat[], refLatDeg: number): Xy[] {
  return points.map(([lon, lat]): Xy => {
    const { x, y } = toLocalXy({ lat, lon }, refLatDeg)
    return [x, y]
  })
}

/**
 * @param line A line, in metres.
 * @param other Another line, in metres.
 * @returns The share of `line`'s length within ON_M of `other`, 0 to 100; null for a line with no length.
 */
export function shareOnLine(line: Xy[], other: Xy[]): number | null {
  if (line.length < 2 || other.length < 1) return null
  const pts = pointsAlong(line, STEP_M)
  const total = pts.reduce((sum, p) => sum + p.m, 0)
  if (total === 0) return null
  const on = pts.filter((p) => distToPolyline(p.p, other) <= ON_M).reduce((sum, p) => sum + p.m, 0)
  return Math.round((100 * on) / total)
}
