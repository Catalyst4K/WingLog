/**
 * Throwaway spike for the cloud-sync plan's "flown route" idea
 * (flightdeck-backend/docs/plans/cloud-sync.md) — not wired into the app, nothing here
 * ships. Runs Douglas-Peucker line simplification against a real recorded flight's
 * track_point rows to see actual compression ratios before that plan's
 * `flight.flownRouteJson` column gets built for real.
 *
 * Self-contained on purpose (raw better-sqlite3, no drizzle/@shared imports) — same style
 * as spike-simconnect.ts/spike-landing.ts, so it doesn't need the app's path aliases to
 * resolve under tsx.
 *
 * Usage: WINGLOG_DB_PATH=<path to a real winglog.db> npm run spike:route-simplify
 * (optionally FLIGHT_ID=<id> to pick a specific flight; defaults to whichever flight has
 * the most track_point rows)
 */
import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'

interface LatLon {
  latitude: number
  longitude: number
}

const METERS_PER_DEG_LAT = 111_320

/** Local equirectangular projection, re-referenced per segment so longitude compression
 *  (which varies with latitude) doesn't distort distance checks over a route that spans
 *  many degrees of latitude — VHHH (~22°N) to WSSS (~1°N) is a good real example of why
 *  a single global reference latitude isn't good enough here. */
function project(point: LatLon, refLatDeg: number): { x: number; y: number } {
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((refLatDeg * Math.PI) / 180)
  return { x: point.longitude * metersPerDegLon, y: point.latitude * METERS_PER_DEG_LAT }
}

function perpendicularDistanceMeters(point: LatLon, lineStart: LatLon, lineEnd: LatLon): number {
  const refLat = (lineStart.latitude + lineEnd.latitude) / 2
  const p = project(point, refLat)
  const a = project(lineStart, refLat)
  const b = project(lineEnd, refLat)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const cross = dx * (p.y - a.y) - dy * (p.x - a.x)
  return Math.abs(cross) / Math.sqrt(lenSq)
}

/** Ramer-Douglas-Peucker. Keeps any point that deviates more than toleranceMeters from
 *  the straight line between its neighbours' kept points — collapses straight cruise
 *  segments, preserves turns/holds/vectoring/go-arounds (the actual point of syncing a
 *  flown route instead of just replaying the planned one). */
function simplify<T extends LatLon>(points: T[], toleranceMeters: number): T[] {
  if (points.length < 3) return points.slice()

  function rdp(pts: T[]): T[] {
    if (pts.length < 3) return pts
    let maxDist = 0
    let index = 0
    const start = pts[0]
    const end = pts[pts.length - 1]
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpendicularDistanceMeters(pts[i], start, end)
      if (d > maxDist) {
        maxDist = d
        index = i
      }
    }
    if (maxDist > toleranceMeters) {
      const left = rdp(pts.slice(0, index + 1))
      const right = rdp(pts.slice(index))
      return left.slice(0, -1).concat(right)
    }
    return [start, end]
  }

  return rdp(points)
}

/** Binary-searches the tolerance needed to hit a point-count budget, for the
 *  "guarantee a payload size" variant discussed in the plan doc, as opposed to a fixed
 *  tolerance whose output size varies with route complexity. */
function simplifyToTargetCount<T extends LatLon>(points: T[], targetCount: number): { result: T[]; toleranceMeters: number } {
  let lo = 0
  let hi = 20_000
  let best = simplify(points, hi)
  let bestTolerance = hi
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    const result = simplify(points, mid)
    if (result.length <= targetCount) {
      hi = mid
      best = result
      bestTolerance = mid
    } else {
      lo = mid
    }
  }
  return { result: best, toleranceMeters: bestTolerance }
}

const dbPath = process.env['WINGLOG_DB_PATH'] ?? './winglog.db'
const db = new Database(dbPath, { readonly: true })

const flightId = process.env['FLIGHT_ID']
  ? Number(process.env['FLIGHT_ID'])
  : (db.prepare('SELECT flight_id FROM track_point GROUP BY flight_id ORDER BY COUNT(*) DESC LIMIT 1').get() as { flight_id: number })
      .flight_id

const flight = db.prepare('SELECT dep_icao, arr_icao, status FROM flight WHERE id = ?').get(flightId) as
  | { dep_icao: string; arr_icao: string; status: string }
  | undefined

const rawPoints = db
  .prepare('SELECT latitude, longitude FROM track_point WHERE flight_id = ? ORDER BY id ASC')
  .all(flightId) as LatLon[]

console.log(`Flight ${flightId}: ${flight?.dep_icao} -> ${flight?.arr_icao} (${flight?.status})`)
console.log(`Raw track_point rows: ${rawPoints.length}\n`)

console.log('Fixed-tolerance results:')
console.log('tolerance (m) | points kept | reduction')
const toleranceResults: { toleranceMeters: number; points: LatLon[] }[] = []
for (const tolerance of [10, 25, 50, 100, 200, 500]) {
  const result = simplify(rawPoints, tolerance)
  toleranceResults.push({ toleranceMeters: tolerance, points: result })
  const reduction = (100 * (1 - result.length / rawPoints.length)).toFixed(1)
  console.log(`${String(tolerance).padStart(13)} | ${String(result.length).padStart(11)} | ${reduction}%`)
}

console.log('\nTarget-point-count results (payload-size guarantee instead of a fixed tolerance):')
console.log('target | actual points | tolerance used (m)')
const targetResults: { target: number; actual: number; toleranceMeters: number }[] = []
for (const target of [50, 100, 150]) {
  const { result, toleranceMeters } = simplifyToTargetCount(rawPoints, target)
  targetResults.push({ target, actual: result.length, toleranceMeters })
  console.log(`${String(target).padStart(6)} | ${String(result.length).padStart(14)} | ${toleranceMeters.toFixed(1)}`)
}

writeFileSync(
  process.argv[2] ?? 'route-simplify-output.json',
  JSON.stringify(
    {
      flightId,
      flight,
      raw: rawPoints,
      tolerances: toleranceResults,
      targets: targetResults
    },
    null,
    2
  )
)
console.log(`\nWrote raw + simplified points to ${process.argv[2] ?? 'route-simplify-output.json'}`)
