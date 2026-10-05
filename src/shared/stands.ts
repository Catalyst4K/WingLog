import type { NavdataStand } from './ipc'

const METRES_PER_DEGREE = 111_320

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lat - b.lat) * METRES_PER_DEGREE, (a.lon - b.lon) * METRES_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180))
}

/** How far from a stand's own point an aircraft can stop and still be "at" it — the real
 *  YBBN-VHHH flight stopped 13 m from N32 and started 15 m from gate 79 (2026-10-02). */
export const AT_STAND_MAX_M = 40

/** The stand an aircraft is parked at, or null if none is close enough. */
export function nearestStand(
  stands: NavdataStand[],
  position: { lat: number; lon: number },
  maxM = AT_STAND_MAX_M
): NavdataStand | null {
  let best: NavdataStand | null = null
  let bestDistance = maxM
  for (const stand of stands) {
    const d = distanceM(stand, position)
    if (d <= bestDistance) {
      best = stand
      bestDistance = d
    }
  }
  return best
}

/** The stand ATC named ("N32"). A name can have twin entries (a MARS stand's halves, carrying
 *  a non-zero suffix); ATC's plain name means the one without. */
export function findStand(stands: NavdataStand[], name: string): NavdataStand | null {
  const matches = stands.filter((s) => s.name.toUpperCase() === name.toUpperCase())
  return matches.find((s) => s.suffix === 0) ?? matches[0] ?? null
}
