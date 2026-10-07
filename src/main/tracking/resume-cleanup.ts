/**
 * Phase 2 of winglog-backend's docs/plans/done/resume-track-cleanup.md: the junk-exclusion pass. Pure (track points in,
 * exclusions and segment fixes out) so it is unit-testable without a sim. `TrackingController` reads the points, calls
 * this, and persists the result.
 *
 * The physically-impossible-jump test (Rule 2) runs over every consecutive pair in the flight, not only inside a
 * resume window: a hold never trips it (a 22-loop hold peaked at 0.51 of the threshold), and a jump can happen with no
 * resume() near it (a payware aircraft's own save-state/reload teleporting the aircraft).
 *
 * A window opens at a real resume() boundary (a resumeSegment change) or at a lone jump found with no window open (a
 * spawn relocation followed by a restore teleport never touches resumeSegment). Nothing about the window's contents is
 * decided until it resolves:
 * - A second jump lands back near the window's own anchor (within CASE_A_LANDING_RADIUS_KM) → Case A: the whole
 *   in-between stretch is junk, plus Case B's rewind check from the re-entry point. Unconditional for a
 *   resume()-opened window (the call is strong evidence on its own); gated on the landing-radius match for a
 *   jump-opened one, since a lone teleport is weaker evidence that a later jump restores it.
 * - The window times out, a real resume() boundary arrives first, or the data ends → neither side is junk; the
 *   aircraft is just somewhere else now. Same fix as Phase 1's explicit resume(): a new synthetic resumeSegment, so the
 *   map stops joining the two sides with a straight line.
 */
import type { TrackPoint } from '@shared/ipc'
import { greatCircleM } from '@shared/geo'

export type CleanupInputPoint = Pick<
  TrackPoint,
  'id' | 'tsUtc' | 'latitude' | 'longitude' | 'headingTrueDeg' | 'groundSpeedMs' | 'simRate' | 'resumeSegment'
>

export interface TrackCleanupResult {
  exclusions: { id: number; reason: 'resume-spurious' | 'resume-superseded' }[]
  segmentReassignments: { id: number; resumeSegment: number }[]
}

/** ~0.5 nm: a sampling-jitter floor under the speed*time*simRate threshold below
 *  (docs/simconnect-notes.md, 2026-09-11). */
const JUMP_DISTANCE_FLOOR_KM = 0.93
const JUMP_SPEED_MULTIPLIER = 2

/** Long enough for a save/restore tool to load. The window opens at the spawn point and must stay open until the
 *  restore resolves it, so it has to cover the spawn-to-restore gap (~426 s for the iniBuilds A350 on the reference
 *  flight), not the anchor-to-spawn gap. 10 minutes leaves headroom above that measurement. */
const RESUME_WINDOW_MS = 10 * 60 * 1000
/** ~3 nm: a real restore landed ~2.9 nm behind its anchor (docs/simconnect-notes.md, 2026-09-11). */
const CASE_A_LANDING_RADIUS_KM = 3 * 1.852
const CASE_B_LATERAL_TOLERANCE_KM = 1 * 1.852
const CASE_B_HEADING_TOLERANCE_DEG = 30

interface LatLon {
  latitude: number
  longitude: number
}

function haversineKm(a: LatLon, b: LatLon): number {
  return greatCircleM({ lat: a.latitude, lon: a.longitude }, { lat: b.latitude, lon: b.longitude }) / 1000
}

function headingDeltaDeg(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

/** `distKm > 2 * min(gsA, gsB) * simRate * dt`, with a floor for sampling jitter. `min`, not `max`: after a crash the
 *  anchor's cruise speed is still on record while nothing was flying, so `max` extrapolates from a stale high speed and
 *  lets a spawn relocation through, while the respawned point's near-zero speed is the real signal. `min` still passes
 *  the genuine cases: a SimConnect reconnect during cruise has consistent speed at both ends, and a sim-pause shows
 *  near-zero drift whichever speed is used (resume-track-cleanup.md, "Teleport"). `simRate` matters because at 4x time
 *  compression the aircraft legitimately covers four times the distance per wall-clock second.
 *
 * @param a The earlier point.
 * @param b The next point.
 * @returns Whether b is further from a than the aircraft could have flown.
 */
export function isPhysicallyImpossibleJump(a: CleanupInputPoint, b: CleanupInputPoint): boolean {
  const dtSec = (Date.parse(b.tsUtc) - Date.parse(a.tsUtc)) / 1000
  if (dtSec <= 0) return false
  const distKm = haversineKm(a, b)
  const minSpeedKmPerSec =
    (JUMP_SPEED_MULTIPLIER * Math.min(a.groundSpeedMs, b.groundSpeedMs) * Math.max(a.simRate, b.simRate, 1)) /
    1000
  const thresholdKm = Math.max(minSpeedKmPerSec * dtSec, JUMP_DISTANCE_FLOOR_KM)
  return distKm > thresholdKm
}

/** Case B: scans backwards from the resume boundary (the whole pre-resume track, not just
 *  the immediately preceding segment — a save could plausibly predate more than one
 *  resume) for the closest earlier point the re-entry point effectively rewound onto.
 *  Returns -1 when nothing matches (most restores don't rewind at all — case A alone).
 *
 * @param points The flight's track.
 * @param boundaryIndex Where the window opened.
 * @param reentry The re-entry point.
 * @returns The index of the point rewound onto, or -1.
 */
function findRewindJoinIndex(
  points: CleanupInputPoint[],
  boundaryIndex: number,
  reentry: CleanupInputPoint
): number {
  for (let k = boundaryIndex - 1; k >= 0; k--) {
    const q = points[k]
    if (
      haversineKm(q, reentry) <= CASE_B_LATERAL_TOLERANCE_KM &&
      headingDeltaDeg(q.headingTrueDeg, reentry.headingTrueDeg) <= CASE_B_HEADING_TOLERANCE_DEG
    ) {
      return k
    }
  }
  return -1
}

/** `points` must already be ordered by id/ts for one flight.
 *
 * A window opens at a real `resume()` boundary or at a lone impossible jump with no window open, and nothing is
 * decided about its contents until it resolves (a second jump, a timeout, or the end of the data), so a stretch of
 * real flying between two jumps is never labelled early.
 *
 * It resolves as Case A (the in-between stretch excluded, plus Case B's rewind check from the re-entry point) when a
 * second jump lands within `CASE_A_LANDING_RADIUS_KM` of the window's anchor (the point before it opened): always for
 * a `resume()`-opened window, only when the radius check passes for a jump-opened one. Otherwise nothing is excluded
 * and a new segment stops the map drawing a straight line across it, as Phase 1 does for `resume()`.
 *
 * @param points The flight's track, in order.
 * @returns The points to exclude, and new segments for the rest.
 */
export function computeTrackCleanup(points: CleanupInputPoint[]): TrackCleanupResult {
  const exclusions: TrackCleanupResult['exclusions'] = []
  const excludedIds = new Set<number>()
  const segmentReassignments = new Map<number, number>()
  if (points.length < 2) return { exclusions, segmentReassignments: [] }

  let maxSegment = points.reduce((m, p) => Math.max(m, p.resumeSegment), 0)
  let activeWindow: { boundaryIndex: number; boundaryTsMs: number; openedByResume: boolean } | null = null

  // A jump-opened window that never resolves as Case A (timeout, a real resume() boundary
  // arriving, or the end of the data) gets a fresh segment for whatever it was holding —
  // never a resume()-opened one, which already has its own real resumeSegment boundary.
  function closeUnresolvedWindow(uptoIndexExclusive: number): void {
    if (!activeWindow || activeWindow.openedByResume) return
    maxSegment += 1
    const newSegment = maxSegment
    for (let k = activeWindow.boundaryIndex; k < uptoIndexExclusive; k++) {
      segmentReassignments.set(points[k].id, newSegment)
    }
  }

  /**
   * Excludes points[from..to) for `reason`, each at most once.
   *
   * @param from The first index excluded.
   * @param to The index after the last.
   * @param reason Why.
   */
  function exclude(
    from: number,
    to: number,
    reason: TrackCleanupResult['exclusions'][number]['reason']
  ): void {
    for (let k = from; k < to; k++) {
      if (excludedIds.has(points[k].id)) continue
      exclusions.push({ id: points[k].id, reason })
      excludedIds.add(points[k].id)
    }
  }

  /**
   * A window resolved as a restore by the jump into points[reentryIndex].
   *
   * @param boundaryIndex Where the window opened.
   * @param reentryIndex The real re-entry point.
   */
  function resolveAsRestore(boundaryIndex: number, reentryIndex: number): void {
    // Case A: everything from the boundary up to the re-entry point is the
    // spawn-then-fly-back junk.
    exclude(boundaryIndex, reentryIndex, 'resume-spurious')
    // Case B: did the sim effectively rewind onto the already-flown track from here? The
    // join point itself is where the trail should now run through, so it survives; only
    // what came strictly after it, up to the anchor, is superseded. A join on the anchor
    // itself (the ordinary Case A outcome, not a rewind) excludes nothing more.
    const joinIndex = findRewindJoinIndex(points, boundaryIndex, points[reentryIndex])
    if (joinIndex !== -1) exclude(joinIndex + 1, boundaryIndex, 'resume-superseded')
  }

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]

    if (b.resumeSegment !== a.resumeSegment) {
      // A real TrackingController.resume() boundary — Phase 1 already breaks the line
      // here. Whatever jump-opened window was still pending never resolved as a restore;
      // give it a new segment now, same as a timeout would, before opening this one.
      closeUnresolvedWindow(i)
      activeWindow = { boundaryIndex: i, boundaryTsMs: Date.parse(b.tsUtc), openedByResume: true }
      continue
    }

    if (activeWindow && Date.parse(b.tsUtc) - activeWindow.boundaryTsMs > RESUME_WINDOW_MS) {
      // Case C: the window timed out with nothing resolving it — real flying continuing on.
      closeUnresolvedWindow(i)
      activeWindow = null
    }

    if (!isPhysicallyImpossibleJump(a, b)) continue

    const window = activeWindow
    const resolvesAsRestore =
      window != null &&
      (window.openedByResume || haversineKm(points[window.boundaryIndex - 1], b) <= CASE_A_LANDING_RADIUS_KM)

    if (window != null && resolvesAsRestore) {
      resolveAsRestore(window.boundaryIndex, i)
      activeWindow = null
    } else if (activeWindow) {
      // A second jump inside a jump-opened window, but it didn't land back near where the
      // window started — not a restore of *this* window, just another, unrelated
      // discontinuity. Close the old window with its own new segment, then let this jump
      // open a fresh window of its own, exactly like the "no window open" case below.
      closeUnresolvedWindow(i)
      activeWindow = { boundaryIndex: i, boundaryTsMs: Date.parse(b.tsUtc), openedByResume: false }
    } else {
      // A physically-impossible jump with no window open (e.g. a payware aircraft's save-state/reload, or the first half
      // of a spawn-then-restore pair): open a window and decide nothing yet; a later jump above resolves it
      // (resume-track-cleanup.md, "New real case found live").
      activeWindow = { boundaryIndex: i, boundaryTsMs: Date.parse(b.tsUtc), openedByResume: false }
    }
  }

  // Anything still pending at the very end of the data never resolved — same treatment as
  // a timeout.
  closeUnresolvedWindow(points.length)

  return {
    exclusions,
    segmentReassignments: [...segmentReassignments].map(([id, resumeSegment]) => ({ id, resumeSegment }))
  }
}

// Re-exported for tests that want to confirm the calibrated constants directly rather than
// reverse-engineering them from behaviour.
export const RESUME_CLEANUP_CONSTANTS = {
  JUMP_DISTANCE_FLOOR_KM,
  JUMP_SPEED_MULTIPLIER,
  RESUME_WINDOW_MS,
  CASE_A_LANDING_RADIUS_KM,
  CASE_B_LATERAL_TOLERANCE_KM,
  CASE_B_HEADING_TOLERANCE_DEG
}
