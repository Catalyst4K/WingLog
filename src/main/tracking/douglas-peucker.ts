/**
 * Ramer-Douglas-Peucker line simplification, generic over the point type: the one implementation
 * the track and flown-route simplifiers use.
 */
export interface Point2D {
  x: number
  y: number
}

/**
 * Distance from a point to the line through two others, on a plane.
 *
 * @param p The point measured.
 * @param a One point on the line.
 * @param b Another point on the line.
 * @returns The distance, in the points' own units.
 */
export function perpendicularDistance2D(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)
  const closestX = a.x + t * dx
  const closestY = a.y + t * dy
  return Math.hypot(p.x - closestX, p.y - closestY)
}

/**
 * Ramer-Douglas-Peucker line simplification, generic over the point type and its distance
 * metric — track-simplify.ts runs this once over lat/lon (via a distance function that
 * re-projects per segment, same as scripts/spike-route-simplify.ts) and again over plain
 * time-vs-altitude and time-vs-speed (x, y) pairs, so the algorithm itself carries no
 * assumption about what a "point" is beyond "distanceFn can measure how far it sits from
 * a line". Returns the *indices* to keep (always including the first and last), not a new
 * points array, so a caller combining several passes over the same source array can just
 * union the index sets.
 *
 * @param points The line, in order.
 * @param tolerance How far a point may be off the simplified line, in distanceFn's units.
 * @param distanceFn A point's distance from the line through two others.
 * @returns The indices kept, always the first and last.
 */
export function simplifyIndices<T>(
  points: T[],
  tolerance: number,
  distanceFn: (point: T, lineStart: T, lineEnd: T) => number
): Set<number> {
  const keep = new Set<number>()
  if (points.length < 3) {
    points.forEach((_, i) => keep.add(i))
    return keep
  }
  keep.add(0)
  keep.add(points.length - 1)

  // Iterative stack instead of recursion — a long, mostly-straight cruise leg is exactly
  // the shape most likely to run this deep, and this is main-process code with no engine
  // stack-depth safety net the way a browser tab would have.
  const stack: [number, number][] = [[0, points.length - 1]]
  for (let range = stack.pop(); range !== undefined; range = stack.pop()) {
    const [startIdx, endIdx] = range
    if (endIdx <= startIdx + 1) continue

    const start = points[startIdx]
    const end = points[endIdx]
    let maxDist = -1
    let maxIdx = -1
    for (let i = startIdx + 1; i < endIdx; i++) {
      const dist = distanceFn(points[i], start, end)
      if (dist > maxDist) {
        maxDist = dist
        maxIdx = i
      }
    }

    if (maxDist > tolerance) {
      keep.add(maxIdx)
      stack.push([startIdx, maxIdx], [maxIdx, endIdx])
    }
  }

  return keep
}
