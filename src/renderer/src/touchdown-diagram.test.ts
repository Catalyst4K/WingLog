import { describe, expect, it } from 'vitest'
import {
  computeTouchdownDiagramLayout,
  evenlySpacedYsPx,
  LATERAL_EXAGGERATION,
  thresholdStripeCountForWidthM,
  touchdownZoneBarCounts,
  touchdownZonePairCountForLengthM,
  touchdownZonePairPositionsM,
  type DiagramRunway
} from './touchdown-diagram'

describe('thresholdStripeCountForWidthM', () => {
  it.each([
    [18, 4],
    [23, 6],
    [30, 8],
    [45, 12],
    [60, 16],
    [80, 16]
  ])('maps a %dm-wide runway to %d threshold stripes', (widthM, expected) => {
    expect(thresholdStripeCountForWidthM(widthM)).toBe(expected)
  })
})

describe('touchdownZonePairCountForLengthM', () => {
  it.each([
    [500, 1],
    [899, 1],
    [900, 2],
    [1199, 2],
    [1200, 3],
    [1499, 3],
    [1500, 4],
    [2399, 4],
    [2400, 6],
    [4000, 6]
  ])('maps a %dm runway to %d touchdown-zone pairs', (lengthM, expected) => {
    expect(touchdownZonePairCountForLengthM(lengthM)).toBe(expected)
  })
})

describe('touchdownZonePairPositionsM', () => {
  it('spaces pairs every 150m starting at 150m, one per band count', () => {
    expect(touchdownZonePairPositionsM(500)).toEqual([150])
    expect(touchdownZonePairPositionsM(1300)).toEqual([150, 300, 450])
    expect(touchdownZonePairPositionsM(3000)).toEqual([150, 300, 450, 600, 750, 900])
  })
})

describe('touchdownZoneBarCounts', () => {
  it.each([
    [1, [1]],
    [2, [2, 1]],
    [3, [3, 2, 1]],
    [4, [3, 2, 1, 1]],
    [6, [3, 2, 1, 1, 2, 3]]
  ])('gives the real countdown pattern %j for %d groups', (totalGroups, expected) => {
    expect(touchdownZoneBarCounts(totalGroups)).toEqual(expected)
  })

  it('falls back to a flat 1-bar pattern for a group count with no real table entry', () => {
    expect(touchdownZoneBarCounts(5)).toEqual([1, 1, 1, 1, 1])
  })
})

const RUNWAY: DiagramRunway = {
  lengthM: 3800,
  widthM: 60,
  displacedThresholdM: 0,
  aimingPointDistanceM: 400
}

describe('computeTouchdownDiagramLayout', () => {
  it('converts metres to px using a consistent scale derived from the window', () => {
    const layout = computeTouchdownDiagramLayout(
      RUNWAY,
      { distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 },
      900
    )
    expect(layout.pxPerM).toBeCloseTo(layout.widthPx / (layout.windowEndM - layout.windowStartM), 6)
    expect(layout.thresholdXPx).toBeCloseTo((0 - layout.windowStartM) * layout.pxPerM, 6)
  })

  it('chooses a window starting at -50m by default (resolveRunwayEnd\'s own tolerance)', () => {
    const layout = computeTouchdownDiagramLayout(
      RUNWAY,
      { distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 },
      900
    )
    expect(layout.windowStartM).toBe(-50)
  })

  it('extends the window earlier when the touchdown tail would otherwise be clipped', () => {
    // A very early, fast touchdown: tail = groundSpeed * 1s could reach well before -50m.
    const layout = computeTouchdownDiagramLayout(
      RUNWAY,
      { distanceFromThresholdM: -50, centrelineOffsetM: 0, groundSpeedMs: 85 },
      900
    )
    // touchdownPhysicalM = -50, tailStart = -50 - 85 = -135, padded by 10 -> -145.
    expect(layout.windowStartM).toBeLessThanOrEqual(-145)
    expect(layout.touchdown.tailStartXPx).toBeGreaterThanOrEqual(0)
  })

  it('caps the window end at the runway length', () => {
    const shortRunway: DiagramRunway = { lengthM: 600, widthM: 30, displacedThresholdM: 0, aimingPointDistanceM: 150 }
    const layout = computeTouchdownDiagramLayout(
      shortRunway,
      { distanceFromThresholdM: 550, centrelineOffsetM: 0, groundSpeedMs: 60 },
      900
    )
    expect(layout.windowEndM).toBeLessThanOrEqual(600)
  })

  it('extends the window to the touchdown point plus a margin when that is later than the touchdown zone', () => {
    const layout = computeTouchdownDiagramLayout(
      RUNWAY,
      { distanceFromThresholdM: 2000, centrelineOffsetM: 0, groundSpeedMs: 60 },
      900
    )
    // touchdown zone ends at 900 (last of 6 pairs) / aiming point 400 -> max 900; touchdown
    // + margin = 2100, which wins.
    expect(layout.windowEndM).toBeCloseTo(2100, 6)
  })

  it('places the displaced threshold section only when the runway has one', () => {
    const undisplaced = computeTouchdownDiagramLayout(
      RUNWAY,
      { distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 },
      900
    )
    expect(undisplaced.displaced).toBeNull()

    const displacedRunway: DiagramRunway = { ...RUNWAY, displacedThresholdM: 200 }
    const displaced = computeTouchdownDiagramLayout(
      displacedRunway,
      { distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 },
      900
    )
    expect(displaced.displaced).not.toBeNull()
    expect(displaced.displaced!.endXPx).toBeCloseTo(displaced.thresholdXPx, 6)
    expect(displaced.displaced!.startXPx).toBeLessThan(displaced.displaced!.endXPx)
    // The usable threshold sits 200m further down the runway than the undisplaced case,
    // so its px position must be further right too.
    expect(displaced.thresholdXPx).toBeGreaterThan(undisplaced.thresholdXPx)
  })

  it('places a touchdown short of the threshold before the threshold bar, still within the window', () => {
    const layout = computeTouchdownDiagramLayout(
      RUNWAY,
      { distanceFromThresholdM: -30, centrelineOffsetM: 0, groundSpeedMs: 60 },
      900
    )
    expect(layout.touchdown.xPx).toBeLessThan(layout.thresholdXPx)
    expect(layout.touchdown.xPx).toBeGreaterThanOrEqual(0)
  })

  it('clamps an offset past the runway edge and flags it, rather than drawing off-surface', () => {
    const layout = computeTouchdownDiagramLayout(
      RUNWAY,
      { distanceFromThresholdM: 350, centrelineOffsetM: 100, groundSpeedMs: 60 }, // 100m >> 30m half-width
      900
    )
    expect(layout.touchdown.offRunwayLaterally).toBe(true)
    // Clamped to the edge: yPx should sit at (or extremely close to) the runway's own
    // rendered edge, not further out.
    expect(layout.touchdown.yPx).toBeCloseTo(layout.heightPx, 6)
  })

  it('does not flag an offset within the runway half-width', () => {
    const layout = computeTouchdownDiagramLayout(
      RUNWAY,
      { distanceFromThresholdM: 350, centrelineOffsetM: 10, groundSpeedMs: 60 },
      900
    )
    expect(layout.touchdown.offRunwayLaterally).toBe(false)
  })

  it('exaggerates the lateral axis by the documented fixed factor', () => {
    const layout = computeTouchdownDiagramLayout(
      RUNWAY,
      { distanceFromThresholdM: 350, centrelineOffsetM: 5, groundSpeedMs: 60 },
      900
    )
    const expectedOffsetPx = 5 * layout.pxPerM * LATERAL_EXAGGERATION
    expect(layout.touchdown.yPx).toBeCloseTo(layout.heightPx / 2 + expectedOffsetPx, 6)
    expect(layout.lateralExaggeration).toBe(LATERAL_EXAGGERATION)
  })

  it('pairs each touchdown-zone group position with its real bar count', () => {
    const layout = computeTouchdownDiagramLayout(
      RUNWAY, // 3800m -> 6 groups
      { distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 },
      900
    )
    expect(layout.touchdownZoneGroups.map((g) => g.barCount)).toEqual([3, 2, 1, 1, 2, 3])
    expect(layout.touchdownZoneGroups).toHaveLength(6)
  })

  it('derives height from the runway width and the exaggerated lateral scale', () => {
    const layout = computeTouchdownDiagramLayout(
      RUNWAY,
      { distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 },
      900
    )
    expect(layout.heightPx).toBeCloseTo(RUNWAY.widthM * layout.pxPerM * LATERAL_EXAGGERATION, 6)
  })
})

describe('evenlySpacedYsPx', () => {
  it('centres each of count positions in its own equal slice', () => {
    expect(evenlySpacedYsPx(4, 100)).toEqual([12.5, 37.5, 62.5, 87.5])
  })

  it('returns an empty array for zero or fewer', () => {
    expect(evenlySpacedYsPx(0, 100)).toEqual([])
  })
})
