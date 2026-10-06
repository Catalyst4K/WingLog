/**
 * ET, time remaining and ETA for the Track page (flightdeck-backend's
 * docs/plans/track-time-readouts.md, Callum 2026-10-02).
 *
 * - **ET**: since takeoff, matching the Logbook's flight time.
 * - **Time remaining**: distance left *along the route* ÷ current ground speed — along the
 *   route rather than straight to the destination, so it stays right around turns and the
 *   arrival. A free flight's route is the great-circle line (logbookGreatCircleRoute).
 * - **ETA**: now + time remaining, against SimBrief's scheduled arrival. On the ground or
 *   crawling, there's no live estimate: the ETA falls back to the scheduled arrival.
 */

import { greatCircleNm, METRES_PER_NM } from '@shared/geo'

/** Below this (~60 kt) a ground-speed estimate is meaningless — taxiing, or a stopped sim. */
const MIN_ESTIMATE_SPEED_MS = 30.9

export interface TrackTimesInput {
  /** [lon, lat] pairs, GeoJSON order, departure to destination. */
  route: [number, number][]
  position: { lat: number; lon: number } | null
  groundSpeedMs: number | null
  onGround: boolean
  takeoffUtc: string | null
  schedInUtc: string | null
  now: number
}

export interface TrackTimes {
  elapsedMs: number | null
  remainingMs: number | null
  /** The live estimate, or the scheduled arrival when there isn't one (`etaIsPlanned`). */
  etaMs: number | null
  etaIsPlanned: boolean
  /** Minutes the live ETA is after (+) or before (−) the schedule; null without both. */
  vsScheduleMin: number | null
}

function nmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  return greatCircleNm({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon })
}

/** Distance left along `route` from the aircraft: to the end of the leg it's nearest to (from
 *  its projection onto that leg), then every leg after it. Null without a usable route. */
export function remainingRouteNm(route: [number, number][], position: { lat: number; lon: number }): number | null {
  if (route.length < 2) return null
  let bestLeg = 0
  let bestDistance = Infinity
  let bestPoint: [number, number] = route[0]!
  for (let i = 0; i < route.length - 1; i++) {
    const [aLon, aLat] = route[i]!
    const [bLon, bLat] = route[i + 1]!
    // Projection in a local flat frame around the leg — exact enough to pick the leg and the
    // point along it; the distances themselves are great-circle.
    const cosLat = Math.cos((((aLat + bLat) / 2) * Math.PI) / 180)
    const ax = aLon * cosLat
    const bx = bLon * cosLat
    const px = position.lon * cosLat
    const lengthSq = (bx - ax) ** 2 + (bLat - aLat) ** 2
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (position.lat - aLat) * (bLat - aLat)) / lengthSq))
    const point: [number, number] = [aLon + t * (bLon - aLon), aLat + t * (bLat - aLat)]
    const distance = nmBetween(position.lat, position.lon, point[1], point[0])
    if (distance < bestDistance) {
      bestDistance = distance
      bestLeg = i
      bestPoint = point
    }
  }
  let total = nmBetween(bestPoint[1], bestPoint[0], route[bestLeg + 1]![1], route[bestLeg + 1]![0])
  for (let i = bestLeg + 1; i < route.length - 1; i++) {
    total += nmBetween(route[i]![1], route[i]![0], route[i + 1]![1], route[i + 1]![0])
  }
  return total
}

export function computeTrackTimes(input: TrackTimesInput): TrackTimes {
  const takeoff = input.takeoffUtc ? Date.parse(input.takeoffUtc) : NaN
  const scheduled = input.schedInUtc ? Date.parse(input.schedInUtc) : NaN
  const elapsedMs = Number.isFinite(takeoff) ? Math.max(0, input.now - takeoff) : null

  const estimating = !input.onGround && input.position !== null && (input.groundSpeedMs ?? 0) >= MIN_ESTIMATE_SPEED_MS
  const remainingNm = estimating ? remainingRouteNm(input.route, input.position!) : null
  const remainingMs = remainingNm !== null ? ((remainingNm * METRES_PER_NM) / input.groundSpeedMs!) * 1000 : null

  if (remainingMs !== null) {
    const etaMs = input.now + remainingMs
    return {
      elapsedMs,
      remainingMs,
      etaMs,
      etaIsPlanned: false,
      vsScheduleMin: Number.isFinite(scheduled) ? Math.round((etaMs - scheduled) / 60_000) : null
    }
  }
  return {
    elapsedMs,
    remainingMs: null,
    etaMs: Number.isFinite(scheduled) ? scheduled : null,
    etaIsPlanned: Number.isFinite(scheduled),
    vsScheduleMin: null
  }
}

/** "5:07" — hours unpadded, minutes padded; "--:--" for nothing. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '--:--'
  const totalMin = Math.floor(ms / 60_000)
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`
}

/** ET: "2:05:30", seconds included since the readout ticks every second (Callum,
 *  2026-10-02). Time remaining stays at formatDuration's minutes: it's an estimate from
 *  ground speed, and ticking seconds would claim a precision it doesn't have. */
export function formatElapsed(ms: number | null): string {
  if (ms === null) return '--:--:--'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')}`
}

/** "08:01Z". */
export function formatUtcTime(ms: number | null): string {
  if (ms === null) return '--:--'
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
}
