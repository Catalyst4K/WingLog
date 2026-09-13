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
 * What actually differs based on whether a resume window is open at the moment a jump is
 * found is what the result means, not whether it's detected:
 * - Inside an active window: Case A (the restore-teleport triangle) and, from its re-entry
 *   point, Case B (rewind onto the already-flown track) — see the plan doc for the full
 *   picture with Callum's screenshot. Junk points are marked, not deleted.
 * - Outside any window (or after one has timed out — Case C): neither side is junk, both
 *   are real telemetry, so nothing is excluded. The aircraft is just somewhere else now;
 *   the fix is the same one Phase 1 already gives an explicit resume() — stop the map
 *   joining the two sides with a straight line — done here by handing the far side a new
 *   synthetic resumeSegment.
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

/** Long enough for a save/restore tool to load — the plan's own starting value, still
 *  uncontradicted by the one real gap measured so far (266s on flight 191, 4m25s on
 *  flight 193 — both comfortably inside 5 minutes). */
const RESUME_WINDOW_MS = 5 * 60 * 1000
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

/** `points` must already be ordered by id/ts for one flight. Landing-radius (Case A) isn't
 *  actually checked as a separate test here — the jump landing "close to the pre-resume
 *  track" and "rewinding onto it" (Case B) are the same haversine test at two different
 *  tolerances (~3nm vs ~1nm), and Case A's own radius only ever mattered for validating
 *  the spike's real numbers, not for classifying anything an unconditional Rule 2 hasn't
 *  already caught — kept here as the documented, calibrated constant regardless, since a
 *  future recalibration pass should have it named rather than inlined. */
export function computeTrackCleanup(points: CleanupInputPoint[]): TrackCleanupResult {
  const exclusions: TrackCleanupResult['exclusions'] = []
  const excludedIds = new Set<number>()
  const segmentReassignments = new Map<number, number>()
  if (points.length < 2) return { exclusions, segmentReassignments: [] }

  let maxSegment = points.reduce((m, p) => Math.max(m, p.resumeSegment), 0)
  let activeWindow: { boundaryIndex: number; boundaryTsMs: number; resumeSegment: number } | null = null

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]

    if (b.resumeSegment !== a.resumeSegment) {
      // A real TrackingController.resume() boundary — Phase 1 already breaks the line
      // here; this just opens the window Case A/B evaluate inside.
      activeWindow = { boundaryIndex: i, boundaryTsMs: Date.parse(b.tsUtc), resumeSegment: b.resumeSegment }
      continue
    }

    if (activeWindow && Date.parse(b.tsUtc) - activeWindow.boundaryTsMs > RESUME_WINDOW_MS) {
      // Case C: the window timed out with nothing resolving it — real flying continuing on,
      // nothing more to do than the boundary Phase 1 already stamped.
      activeWindow = null
    }

    if (!isPhysicallyImpossibleJump(a, b)) continue

    if (activeWindow && a.resumeSegment === activeWindow.resumeSegment) {
      // Case A: everything from the boundary through `a` is the spawn-then-fly-back junk;
      // `b` is the real re-entry point.
      for (let k = activeWindow.boundaryIndex; k <= i - 1; k++) {
        if (excludedIds.has(points[k].id)) continue
        exclusions.push({ id: points[k].id, reason: 'resume-spurious' })
        excludedIds.add(points[k].id)
      }
      // Case B: did the sim effectively rewind onto the already-flown track from here? Q
      // itself (joinIndex) is the point the trail should now run through, so it survives —
      // only what came strictly after it, up to the anchor, is superseded. A join that
      // lands on the anchor itself (the ordinary, expected Case A outcome, not a rewind)
      // naturally excludes nothing more here, since there's nothing strictly between them.
      const joinIndex = findRewindJoinIndex(points, activeWindow.boundaryIndex, b)
      if (joinIndex !== -1) {
        for (let k = joinIndex + 1; k < activeWindow.boundaryIndex; k++) {
          if (excludedIds.has(points[k].id)) continue
          exclusions.push({ id: points[k].id, reason: 'resume-superseded' })
          excludedIds.add(points[k].id)
        }
      }
      activeWindow = null
    } else {
      // A physically-impossible jump with no resume window open at all — e.g. a payware
      // aircraft's own save-state/reload feature, confirmed live with no WingLog resume
      // anywhere near it (resume-track-cleanup.md, "New real case found live, 2026-09-13").
      // Neither side is junk; give everything from here to the end of this run of samples
      // a new segment id so the map breaks the line instead of drawing a straight jump
      // across it.
      maxSegment += 1
      const newSegment = maxSegment
      const runSegment = b.resumeSegment
      for (let k = i; k < points.length && points[k].resumeSegment === runSegment; k++) {
        segmentReassignments.set(points[k].id, newSegment)
      }
    }
  }

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
