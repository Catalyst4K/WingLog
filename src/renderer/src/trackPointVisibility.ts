import type { TrackPoint } from '@shared/ipc'

/**
 * Drops points a resume-cleanup pass has flagged as junk (flightdeck-backend's docs/plans/
 * resume-track-cleanup.md) — a crash-resume's spawn-then-fly-back triangle, or the far
 * side of a mid-flight teleport rewound onto the already-flown track. Kept as its own pure
 * function (rather than inline in FlightMap.tsx) so the filtering rule itself — and not
 * just "FlightMap doesn't crash with an excluded point present" — has a direct test.
 */
export function filterVisibleTrackPoints(points: TrackPoint[]): TrackPoint[] {
  return points.filter((p) => p.excludedReason == null)
}
