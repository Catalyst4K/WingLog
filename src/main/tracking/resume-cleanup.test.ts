import { describe, expect, it } from 'vitest'
import { computeTrackCleanup, isPhysicallyImpossibleJump, type CleanupInputPoint } from './resume-cleanup'

const BASE = Date.parse('2026-09-13T12:00:00.000Z')

/** Builds one point at `offsetSec` after BASE. Coordinates are plain degrees offsets from
 *  (0, 0) scaled small enough that 0.01 deg of latitude is roughly 1.1km — good enough for
 *  readable, hand-checkable fixtures without needing real airport coordinates. */
function pt(
  id: number,
  offsetSec: number,
  latDeg: number,
  lonDeg: number,
  overrides: Partial<Omit<CleanupInputPoint, 'id' | 'tsUtc' | 'latitude' | 'longitude'>> = {}
): CleanupInputPoint {
  return {
    id,
    tsUtc: new Date(BASE + offsetSec * 1000).toISOString(),
    latitude: latDeg,
    longitude: lonDeg,
    headingTrueDeg: 0,
    groundSpeedMs: 150,
    simRate: 1,
    resumeSegment: 0,
    ...overrides
  }
}

describe('computeTrackCleanup', () => {
  it('excludes nothing for a flight with fewer than 2 points', () => {
    expect(computeTrackCleanup([])).toEqual({ exclusions: [], segmentReassignments: [] })
    expect(computeTrackCleanup([pt(1, 0, 0, 0)])).toEqual({ exclusions: [], segmentReassignments: [] })
  })

  it('excludes nothing for ordinary continuous flying, even at a real cruise ground speed', () => {
    // ~250 m/s ground speed, 5s downsampling (cruise interval) — roughly 0.011 deg lat per
    // sample, well inside the jump threshold for that speed/interval.
    const points: CleanupInputPoint[] = []
    for (let i = 0; i < 20; i++) {
      points.push(pt(i, i * 5, i * 0.011, 0, { groundSpeedMs: 250 }))
    }
    expect(computeTrackCleanup(points)).toEqual({ exclusions: [], segmentReassignments: [] })
  })

  it('catches a real crash-relocation where the anchor\'s own stale high speed would otherwise mask it (flight 191/CPA319, confirmed live 2026-09-13)', () => {
    // Real numbers: 266.647s gap, 81.23km, anchor still showing pre-crash cruise speed
    // (260.7 m/s) while the freshly-respawned point reads near-stationary (8.8 m/s). Using
    // max(gsA, gsB) here gives a ~139km threshold and lets this through — exactly what
    // Callum found still drawn as a straight line after running Clean up track on this
    // flight; min(gsA, gsB) gives ~4.7km and correctly flags it.
    const a: CleanupInputPoint = {
      id: 1,
      tsUtc: '2026-09-10T22:06:00.237Z',
      latitude: 10,
      longitude: 110,
      headingTrueDeg: 90,
      groundSpeedMs: 260.7,
      simRate: 1,
      resumeSegment: 0
    }
    const b: CleanupInputPoint = {
      id: 2,
      tsUtc: '2026-09-10T22:10:26.884Z',
      // ~81.23km east of `a` at this latitude.
      latitude: 10,
      longitude: 110 + 81.23 / (111.32 * Math.cos((10 * Math.PI) / 180)),
      headingTrueDeg: 90,
      groundSpeedMs: 8.8,
      simRate: 1,
      resumeSegment: 0
    }
    expect(isPhysicallyImpossibleJump(a, b)).toBe(true)
  })

  it('does not flag a real SimConnect-reconnect gap where both ends show consistent real cruise speed', () => {
    // A dropped/reconnected telemetry connection can leave a similarly long gap with real
    // distance covered — but unlike a crash-relocation, both ends read genuine, matching
    // ground speed, since the aircraft never actually stopped flying. min(gsA, gsB) stays
    // large here, same as max(gsA, gsB) would, so this is never mistaken for a teleport.
    const a = pt(1, 0, 0, 0, { groundSpeedMs: 250 })
    const b = pt(2, 266, 81.23 / 111.32, 0, { groundSpeedMs: 250 }) // ~81.23km north, 266s later
    expect(isPhysicallyImpossibleJump(a, b)).toBe(false)
  })

  it('does not flag a real sim-pause with minor position drift (flight 191/CPA319\'s own two real pauses)', () => {
    // Real numbers: a 2.7-hour pause with 0.56km of drift, and a 20-minute pause with
    // 1.17km of drift — both well past any reasonable "sampling jitter" floor if taken at
    // face value, but tiny next to the 81km/132km real relocations above. Confirms the
    // floor doesn't need to shrink to catch real teleports, so pause-jitter still passes.
    const longPause = pt(1, 0, 0, 0, { groundSpeedMs: 280.1 })
    const afterLongPause = pt(2, 9865, 0.56 / 111.32, 0, { groundSpeedMs: 280.1 })
    expect(isPhysicallyImpossibleJump(longPause, afterLongPause)).toBe(false)

    const shortPause = pt(3, 0, 0, 0, { groundSpeedMs: 208.9 })
    const afterShortPause = pt(4, 1209, 1.17 / 111.32, 0, { groundSpeedMs: 209.6 })
    expect(isPhysicallyImpossibleJump(shortPause, afterShortPause)).toBe(false)
  })

  it('excludes the whole spawn-then-fly-then-restore stretch even with no resumeSegment change at all (flight 191/CPA319, confirmed live 2026-09-13)', () => {
    // Callum's own report after the min(gsA,gsB) fix: it caught the restore-teleport but
    // "left behind the bit of flying the A350 did after it loaded in until I was able to
    // reload the save" — the spawn-jump and the restore-jump each opened/were checked
    // against their own independent "no window open" case, so the real (if geographically
    // meaningless) flying in between was resegmented, not excluded, and stayed visible as
    // its own floating line. Since flight 191 predates Phase 1, resumeSegment is 0
    // throughout — neither jump ever gets a real resume() boundary to open a window, so
    // this only works if a lone jump can open its own provisional window that a *later*
    // jump can still resolve as Case A, provided it lands back near where the window
    // started (here, easily inside CASE_A_LANDING_RADIUS_KM of the anchor).
    const anchor = pt(1, 0, 0, 0, { groundSpeedMs: 260.7 })
    // ~81km away, near-stationary — the real spawn-relocation numbers.
    const spawn = pt(2, 266.6, 81.23 / 111.32, 0, { groundSpeedMs: 8.8 })
    // A few minutes of genuine flying at the wrong (post-crash) location.
    const flying1 = pt(3, 300, 81.24 / 111.32, 0, { groundSpeedMs: 60 })
    const flying2 = pt(4, 400, 81.3 / 111.32, 0, { groundSpeedMs: 90 })
    // Restore teleport lands ~2.9nm behind the anchor, matching the plan's own calibration.
    const restore = pt(5, 417.8, 0.001, 0.001, { groundSpeedMs: 216.9 })
    const after = pt(6, 425, 0.01, 0.001, { groundSpeedMs: 200 })

    const result = computeTrackCleanup([anchor, spawn, flying1, flying2, restore, after])
    expect(result.exclusions.map((e) => e.id).sort()).toEqual([2, 3, 4])
    expect(result.exclusions.every((e) => e.reason === 'resume-spurious')).toBe(true)
    expect(result.segmentReassignments).toEqual([])
  })

  it('does not flag a real 4x sim-rate cruise sample as a teleport', () => {
    // 250 m/s * 4x rate * 5s = 5000m = ~0.045 deg lat — under the 2x-multiplier threshold.
    const a = pt(1, 0, 0, 0, { groundSpeedMs: 250, simRate: 4 })
    const b = pt(2, 5, 0.045, 0, { groundSpeedMs: 250, simRate: 4 })
    expect(computeTrackCleanup([a, b])).toEqual({ exclusions: [], segmentReassignments: [] })
  })

  it('excludes nothing across a pause (time gap, no position change)', () => {
    const a = pt(1, 0, 10, 10, { groundSpeedMs: 0 })
    // 10 minutes later, same position — a real sim-pause gap, not a teleport.
    const b = pt(2, 600, 10, 10, { groundSpeedMs: 0 })
    expect(computeTrackCleanup([a, b])).toEqual({ exclusions: [], segmentReassignments: [] })
  })

  it('flags nothing across a genuine 22-loop hold (regression fixture, flight 193/PECAN)', () => {
    // Real calibration: 194 points over 18 minutes, zero physically-impossible jumps, max
    // dist/threshold ratio 0.51 (resume-track-cleanup.md, "settled 2026-09-13"). Modelled
    // here as a tight circle flown at a steady ground speed and 1Hz sampling — the actual
    // property under test is that continuous, always-in-range motion never trips Rule 2,
    // regardless of how much it doubles back on itself.
    const points: CleanupInputPoint[] = []
    const loops = 4
    const samplesPerLoop = 40
    const radiusDeg = 0.02
    for (let i = 0; i < loops * samplesPerLoop; i++) {
      const angle = (i / samplesPerLoop) * 2 * Math.PI
      points.push(
        pt(i, i, radiusDeg * Math.sin(angle), radiusDeg * Math.cos(angle), {
          groundSpeedMs: 120,
          headingTrueDeg: (angle * 180) / Math.PI
        })
      )
    }
    expect(computeTrackCleanup(points)).toEqual({ exclusions: [], segmentReassignments: [] })
  })

  it('Case A: excludes the spawn-then-fly-back junk between a resume boundary and the restore teleport', () => {
    const anchor = pt(1, 0, 0, 0, { resumeSegment: 0 })
    // Resume boundary: a new resumeSegment starts here (the sim's spawn point, far away).
    const spawn = pt(2, 300, 5, 5, { resumeSegment: 1 })
    const flyingBack1 = pt(3, 305, 5.001, 5.001, { resumeSegment: 1 })
    const flyingBack2 = pt(4, 310, 5.002, 5.002, { resumeSegment: 1 })
    // The restore-tool teleport: instantly back near the anchor.
    const reentry = pt(5, 311, 0.001, 0.001, { resumeSegment: 1 })
    const after = pt(6, 316, 0.002, 0.002, { resumeSegment: 1 })

    const result = computeTrackCleanup([anchor, spawn, flyingBack1, flyingBack2, reentry, after])
    expect(result.exclusions.map((e) => e.id).sort()).toEqual([2, 3, 4])
    expect(result.exclusions.every((e) => e.reason === 'resume-spurious')).toBe(true)
    expect(result.segmentReassignments).toEqual([])
  })

  it('Case B: excludes the pre-resume stretch the restore rewound onto, once the re-entry point matches it', () => {
    // 30s/real-cruise-speed spacing so q -> afterQ1 -> afterQ2 themselves never look like a
    // jump, while still landing well outside Case B's ~1nm tolerance of reentry (only q
    // itself, close to (0,0), should match it).
    const q = pt(1, 0, 0, 0, { headingTrueDeg: 90, groundSpeedMs: 250 })
    const afterQ1 = pt(2, 30, 0.03, 0, { headingTrueDeg: 90, groundSpeedMs: 250 })
    const afterQ2 = pt(3, 60, 0.06, 0, { headingTrueDeg: 90, groundSpeedMs: 250 })
    // Resume boundary — anchor was afterQ2, spawns far away.
    const spawn = pt(4, 300, 5, 5, { resumeSegment: 1 })
    // Restore teleport lands back essentially on top of Q, same heading — the sim rewound.
    const reentry = pt(5, 301, 0.0002, 0.0002, { resumeSegment: 1, headingTrueDeg: 90 })
    const after = pt(6, 306, 0.06, 0, { resumeSegment: 1, headingTrueDeg: 90 })

    const result = computeTrackCleanup([q, afterQ1, afterQ2, spawn, reentry, after])
    const excludedIds = result.exclusions.map((e) => e.id).sort()
    expect(excludedIds).toEqual([2, 3, 4])
    expect(result.exclusions.find((e) => e.id === 4)?.reason).toBe('resume-spurious')
    expect(result.exclusions.find((e) => e.id === 2)?.reason).toBe('resume-superseded')
    expect(result.exclusions.find((e) => e.id === 3)?.reason).toBe('resume-superseded')
  })

  it('Case C: excludes nothing when a resume window times out with no teleport (real flying continues)', () => {
    const anchor = pt(1, 0, 0, 0, { resumeSegment: 0 })
    const boundary = pt(2, 100, 5, 5, { resumeSegment: 1, groundSpeedMs: 200 })
    // Still flying normally, no jump, well past the 5-minute window — both ends show the
    // same real cruise speed, the actual signature of continuous flight (as opposed to
    // one end reading near-zero because the aircraft had just respawned, the real
    // discontinuity isPhysicallyImpossibleJump's own min(gsA, gsB) is built to catch).
    const later = pt(3, 100 + 6 * 60, 5.5, 5.5, { resumeSegment: 1, groundSpeedMs: 200 })
    expect(computeTrackCleanup([anchor, boundary, later])).toEqual({ exclusions: [], segmentReassignments: [] })
  })

  it('a physically-impossible jump with no resume window open reassigns a new segment instead of excluding anything', () => {
    // No resumeSegment change anywhere — matches flight 193's real iniBuilds save-state
    // teleport: 59.9km in 12s, resumeSegment unchanged on both sides.
    const before1 = pt(1, 0, 0, 0)
    const before2 = pt(2, 5, 0.001, 0.001)
    const jumpTo = pt(3, 17, 0.5, 0.5)
    const after1 = pt(4, 22, 0.501, 0.501)
    const after2 = pt(5, 27, 0.502, 0.502)

    const result = computeTrackCleanup([before1, before2, jumpTo, after1, after2])
    expect(result.exclusions).toEqual([])
    expect(result.segmentReassignments.map((r) => r.id).sort()).toEqual([3, 4, 5])
    const segments = new Set(result.segmentReassignments.map((r) => r.resumeSegment))
    expect(segments.size).toBe(1)
  })

  it('two resumes in one flight are handled independently', () => {
    const anchor1 = pt(1, 0, 0, 0, { resumeSegment: 0 })
    const spawn1 = pt(2, 300, 5, 5, { resumeSegment: 1 })
    const reentry1 = pt(3, 301, 0.001, 0.001, { resumeSegment: 1 })
    const anchor2 = pt(4, 400, 0.002, 0.002, { resumeSegment: 1 })
    const spawn2 = pt(5, 700, 8, 8, { resumeSegment: 2 })
    const reentry2 = pt(6, 701, 0.003, 0.003, { resumeSegment: 2 })

    const result = computeTrackCleanup([anchor1, spawn1, reentry1, anchor2, spawn2, reentry2])
    expect(result.exclusions.map((e) => e.id).sort()).toEqual([2, 5])
    expect(result.exclusions.every((e) => e.reason === 'resume-spurious')).toBe(true)
  })

  it('a later jump in the same unresumed run gets its own, more specific segment', () => {
    const a = pt(1, 0, 0, 0)
    const b = pt(2, 5, 0.001, 0.001)
    const jump1 = pt(3, 17, 0.5, 0.5)
    const c = pt(4, 22, 0.501, 0.501)
    const jump2 = pt(5, 30, 1.5, 1.5)
    const d = pt(6, 35, 1.501, 1.501)

    const result = computeTrackCleanup([a, b, jump1, c, jump2, d])
    const byId = new Map(result.segmentReassignments.map((r) => [r.id, r.resumeSegment]))
    // Everything from jump1 onward first got one new segment; jump2 then overrides the
    // tail (jump2 and d) with an even newer one, so id 3/4 differ from id 5/6.
    expect(byId.get(3)).toBe(byId.get(4))
    expect(byId.get(5)).toBe(byId.get(6))
    expect(byId.get(3)).not.toBe(byId.get(5))
  })
})
