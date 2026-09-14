/**
 * Phase 2 of flightdeck-backend's docs/plans/done/resume-track-cleanup.md — the actual
 * junk-exclusion pass. Pure by design (track points in, exclusions/segment fixes out) so
 * it's unit-testable without a sim, per CLAUDE.md's testing rule. `TrackingController`
 * (not this file) is responsible for reading points, calling this, and persisting the
 * result.
 *
 * Rule 2 — the physically-impossible-jump test — runs unconditionally over every
 * consecutive pair in the flight, not just inside a resume window. That's a deliberate
 * change from the plan's original sketch, settled 2026-09-13 after two real findings on
 * the same live flight (193): a genuine 22-loop hold at PECAN produced zero jumps end to
 * end (max distance/threshold ratio 0.51), confirming a hold can never trip this test on
 * its own regardless of whether a resume window is open — so gating Rule 2 by window was
 * only ever needed to keep shape-based checks away from a hold, not this one. Separately,
 * the same flight surfaced a jump with no resume() anywhere near it at all (the iniBuilds
 * A350's own save-state/reload feature teleporting the aircraft), which the
 * window-gated-only design would never have looked at.
 *
 * A window opens either at a real resume() boundary (a resumeSegment change) or — settled
 * live 2026-09-13, against flight 191/CPA319's real double-jump pattern (a spawn-relocation
 * followed minutes later by a restore-teleport, neither ever touching resumeSegment since
 * no WingLog resume() was involved) — at a lone jump found with no window already open.
 * Either way, nothing about the window's contents is decided until it resolves:
 * - A second jump lands back near the window's own anchor (within CASE_A_LANDING_RADIUS_KM)
 *   → Case A: the whole in-between stretch is junk, plus Case B's rewind check from the
 *   re-entry point. Unconditional for a resume()-opened window (the resume() call is
 *   already strong evidence on its own); gated on the landing-radius match for a
 *   jump-opened one, since a lone teleport alone is weaker evidence that a later jump is
 *   really a restore of *it* rather than a second, unrelated event.
 * - The window times out, or a real resume() boundary arrives before anything resolves it,
 *   or the data just ends — neither side of the original jump is junk, both are real
 *   telemetry; the aircraft (or the window's own pending stretch) is just somewhere else
 *   now. Same fix Phase 1 already gives an explicit resume(): stop the map joining the two
 *   sides with a straight line, via a new synthetic resumeSegment.
 */
import type { TrackPoint } from '@shared/ipc'

export type CleanupInputPoint = Pick<
  TrackPoint,
  'id' | 'tsUtc' | 'latitude' | 'longitude' | 'headingTrueDeg' | 'groundSpeedMs' | 'simRate' | 'resumeSegment'
>

export interface TrackCleanupResult {
  exclusions: { id: number; reason: 'resume-spurious' | 'resume-superseded' }[]
  segmentReassignments: { id: number; resumeSegment: number }[]
}

const EARTH_RADIUS_KM = 6371
/** ~0.5 nm — a sampling-jitter floor under the speed*time*simRate threshold below, same
 *  value the Phase 2 spike used against real flight 191 (docs/simconnect-notes.md,
 *  2026-09-11). */
const JUMP_DISTANCE_FLOOR_KM = 0.93
const JUMP_SPEED_MULTIPLIER = 2

/** Long enough for a save/restore tool to load. The plan's original 5-minute guess
 *  measured the wrong gap on its own reference flight (191): 266s and 4m25s (flight 193)
 *  are both the *anchor-to-spawn* gap, not the window this constant actually needs to
 *  cover — the window opens at the spawn point and needs to stay open until the restore
 *  resolves it. Confirmed live 2026-09-13, running the real "Clean up track" pass against
 *  flight 191's actual data: its real spawn-to-restore gap is ~426s (the iniBuilds A350
 *  taking that long to reach the OFP screen and reload the save) — comfortably past the
 *  old 5-minute window, so the window timed out and closed the case as an ordinary segment
 *  break (Case C) before the restore-teleport ever arrived to resolve it as Case A. Moved
 *  to 10 minutes — real headroom above the one real measurement in hand, not a tight fit
 *  to it. */
const RESUME_WINDOW_MS = 10 * 60 * 1000
/** ~3 nm — moved up from the plan's original ~2 nm guess after the real flight 191 restore
 *  landed ~2.9 nm behind its anchor (docs/simconnect-notes.md, 2026-09-11). */
const CASE_A_LANDING_RADIUS_KM = 3 * 1.852
const CASE_B_LATERAL_TOLERANCE_KM = 1 * 1.852
const CASE_B_HEADING_TOLERANCE_DEG = 30

interface LatLon {
  latitude: number
  longitude: number
}

function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180
  const lat1 = (a.latitude * Math.PI) / 180
  const lat2 = (b.latitude * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h))
}

function headingDeltaDeg(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

/** `distKm > 2 * min(gsA, gsB) * simRate * dt`, with a floor for sampling jitter — the
 *  plan doc's own formula (resume-track-cleanup.md, "Teleport") originally used `max`, but
 *  that badly overestimates how far a crash/restart could plausibly have covered: real
 *  flight 191 (CPA319) has a genuine 81km/266s spawn-relocation where the anchor's own
 *  cruise ground speed (260.7 m/s) was still on record from *before* the crash, even
 *  though nothing was actually flying for most of the gap — `max` extrapolated from that
 *  stale high speed and let 81km through (threshold ~139km), while the spawn point's own
 *  near-zero speed (8.8 m/s, freshly respawned) is the real signal something happened.
 *  `min` catches this while still passing every already-confirmed real case: a genuine
 *  SimConnect reconnect during continued cruise shows *consistent* real speed at both
 *  ends (min is then still large, same as max would be), and a real sim-pause shows near-
 *  zero position drift regardless of which speed is used. Confirmed live 2026-09-13
 *  against flight 191's complete real track: `min` catches both of its genuine
 *  discontinuities (the 81km spawn-relocation and the already-confirmed 132km restore-
 *  teleport) with zero new false positives across all 7,889 points, including its own two
 *  genuine sim-pause gaps (up to 2.7 hours, under half a km of drift each). `simRate`
 *  matters because at e.g. 4x time compression the aircraft legitimately covers four times
 *  the distance per wall-clock second; without it, cruise under time compression would
 *  look like teleporting. */
export function isPhysicallyImpossibleJump(a: CleanupInputPoint, b: CleanupInputPoint): boolean {
  const dtSec = (Date.parse(b.tsUtc) - Date.parse(a.tsUtc)) / 1000
  if (dtSec <= 0) return false
  const distKm = haversineKm(a, b)
  const minSpeedKmPerSec =
    (JUMP_SPEED_MULTIPLIER * Math.min(a.groundSpeedMs, b.groundSpeedMs) * Math.max(a.simRate, b.simRate, 1)) / 1000
  const thresholdKm = Math.max(minSpeedKmPerSec * dtSec, JUMP_DISTANCE_FLOOR_KM)
  return distKm > thresholdKm
}

/** Case B: scans backwards from the resume boundary (the whole pre-resume track, not just
 *  the immediately preceding segment — a save could plausibly predate more than one
 *  resume) for the closest earlier point the re-entry point effectively rewound onto.
 *  Returns -1 when nothing matches (most restores don't rewind at all — case A alone). */
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
 * A window opens either at a real `resume()` boundary (a `resumeSegment` change) or at a
 * lone physically-impossible jump with no window already open — the latter is what turned
 * out to matter live, 2026-09-13: a payware aircraft's save-state/reload feature (or a
 * spawn-then-restore pair, flight 191/CPA319) never touches `resumeSegment` at all, since
 * no WingLog `resume()` is involved. Either way, nothing is decided about the window's
 * contents until it *resolves* — a second jump within it, a timeout, or the end of the
 * data — so a stretch of real (if geographically meaningless) flying between two jumps
 * never gets prematurely labelled.
 *
 * A window resolves as Case A (the in-between stretch excluded as junk, plus Case B's
 * rewind check from the re-entry point) when a second jump's landing point comes back
 * within `CASE_A_LANDING_RADIUS_KM` of the window's own anchor (the point right before it
 * opened) — unconditionally for a `resume()`-opened window (the explicit `resume()` call is
 * already strong enough evidence on its own that this is a genuine restore, confirmed
 * against every real case seen so far), but only when that radius check actually passes
 * for a jump-opened one, since a lone teleport is much weaker evidence that *this specific*
 * later jump is a restore of *it* rather than a second, unrelated event. A jump-opened
 * window that doesn't resolve as Case A (no second jump before timeout, or one that lands
 * nowhere near the anchor) gets the same treatment Phase 1 already gives an explicit
 * `resume()`: nothing excluded, just a new segment so the map stops drawing a straight
 * line across it. */
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
      // Case A: everything from the boundary through `a` is the spawn-then-fly-back junk;
      // `b` is the real re-entry point.
      for (let k = window.boundaryIndex; k <= i - 1; k++) {
        if (excludedIds.has(points[k].id)) continue
        exclusions.push({ id: points[k].id, reason: 'resume-spurious' })
        excludedIds.add(points[k].id)
      }
      // Case B: did the sim effectively rewind onto the already-flown track from here? Q
      // itself (joinIndex) is the point the trail should now run through, so it survives —
      // only what came strictly after it, up to the anchor, is superseded. A join that
      // lands on the anchor itself (the ordinary, expected Case A outcome, not a rewind)
      // naturally excludes nothing more here, since there's nothing strictly between them.
      const joinIndex = findRewindJoinIndex(points, window.boundaryIndex, b)
      if (joinIndex !== -1) {
        for (let k = joinIndex + 1; k < window.boundaryIndex; k++) {
          if (excludedIds.has(points[k].id)) continue
          exclusions.push({ id: points[k].id, reason: 'resume-superseded' })
          excludedIds.add(points[k].id)
        }
      }
      activeWindow = null
    } else if (activeWindow) {
      // A second jump inside a jump-opened window, but it didn't land back near where the
      // window started — not a restore of *this* window, just another, unrelated
      // discontinuity. Close the old window with its own new segment, then let this jump
      // open a fresh window of its own, exactly like the "no window open" case below.
      closeUnresolvedWindow(i)
      activeWindow = { boundaryIndex: i, boundaryTsMs: Date.parse(b.tsUtc), openedByResume: false }
    } else {
      // A physically-impossible jump with no window open at all — e.g. a payware
      // aircraft's own save-state/reload feature, confirmed live with no WingLog resume
      // anywhere near it (resume-track-cleanup.md, "New real case found live, 2026-09-13"),
      // or the first half of a spawn-then-restore pair that likewise never touches
      // resumeSegment (also confirmed live, flight 191/CPA319). Open a window rather than
      // deciding anything yet — resolved above if a later jump lands back near here.
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
