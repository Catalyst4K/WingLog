/**
 * Pure metres-to-pixels layout for Logbook's touchdown diagram (LandingCard,
 * docs/plans/logbook-detail-improvements.md) — no rendering, just the numbers a
 * TouchdownDiagram.tsx <svg> draws from. Kept separate so the geometry (visible window,
 * marking positions, clamping) is exactly checkable by hand, the same reasoning
 * landing-maths.ts already follows for the crosswind/centreline maths this reads.
 *
 * ICAO Annex 14 marking counts (threshold stripes by runway width, §5.2.3; touchdown-zone
 * pairs by landing distance available, §5.2.6) are sourced from the Manual of Aerodrome
 * Standards' tables — the same secondary source runway-lookup.ts's own
 * aimingPointDistanceForLengthM already cites — cross-checked against Annex 14's own text
 * describing the same bands (a fixed stripe/pair count per band, never interpolated).
 *
 * Coordinates are all in the runway's own "physical-start" frame: 0 = the physical
 * beginning of the paved surface (the same point runway-lookup.ts's RunwayEnd.lat/lon
 * describes — see its doc comment), increasing in the landing direction.
 * Landing.distanceFromThresholdM is measured from the *usable* (displacement-adjusted)
 * threshold instead, so every distance below adds `displacedThresholdM` once to get back
 * to this frame.
 */

export interface DiagramRunway {
  lengthM: number
  widthM: number
  displacedThresholdM: number
  aimingPointDistanceM: number
}

export interface DiagramTouchdown {
  /** Usable-threshold-relative, signed — same convention as Landing.distanceFromThresholdM.
   *  Negative means short of the usable threshold (within a displaced section, or, within
   *  resolveRunwayEnd's own -50m tolerance, even before the physical runway start). */
  distanceFromThresholdM: number
  /** Signed, positive = right of centreline — same convention as Landing.centrelineOffsetM. */
  centrelineOffsetM: number
  /** Feeds the tail behind the dot — see TOUCHDOWN_CAPTURE_SECONDS below. */
  groundSpeedMs: number
}

/** How much the lateral (cross-runway) axis is stretched relative to the along-track axis
 *  so a touchdown offset of a few metres is more than a rounding error on screen — the
 *  plan's own worked example: a 45m-wide runway drawn true-scale over ~1,200m is only
 *  ~17px tall in a typical card. Fixed and always labelled on the diagram (never applied
 *  silently), rather than computed per-runway — a single documented factor is easier to
 *  read consistently across different flights than a value that changes card to card. */
export const LATERAL_EXAGGERATION = 3

// Matches resolveRunwayEnd's own MIN_ALONG_TRACK_M tolerance (runway-lookup.ts) — a
// touchdown this far short of the physical runway start is still considered "on" it, so
// the diagram's default window always has room to show one that short.
const WINDOW_START_MIN_M = -50
// Padding so the tail (one second of ground roll behind the dot) is never flush with the
// window edge, when it pushes the window earlier than WINDOW_START_MIN_M would alone.
const WINDOW_START_PADDING_M = 10
// "touchdown + margin" per the plan — how far past the touchdown point the window extends
// when that's later than the end of the touchdown zone (e.g. a long floated landing).
const WINDOW_END_MARGIN_AFTER_TOUCHDOWN_M = 100
// TrackingController builds the landing record from the first on-ground tick of a 1 Hz
// feed — the real touchdown happened somewhere in the second before (see landing-
// capture.ts's own doc comment). The tail visualizes that whole window, not a precise point.
const TOUCHDOWN_CAPTURE_SECONDS = 1

/** ICAO Annex 14 §5.2.3 threshold marking — stripe count by runway width (Manual of
 *  Aerodrome Standards table: 18m→4, 23m→6, 30m→8, 45m→12, 60m→16 — matching
 *  aimingPointDistanceForLengthM's own citation). A width between two standard values
 *  rounds up to the next band, same `<=`/`<` style as that function. */
export function thresholdStripeCountForWidthM(widthM: number): number {
  if (widthM <= 18) return 4
  if (widthM <= 23) return 6
  if (widthM <= 30) return 8
  if (widthM <= 45) return 12
  return 16
}

/** ICAO Annex 14 §5.2.6 touchdown zone marking — pair count by landing distance available
 *  (same source as thresholdStripeCountForWidthM: <900m→1, <1200m→2, <1500m→3, <2400m→4,
 *  ≥2400m→6 — note there is no "5 pairs" band). */
export function touchdownZonePairCountForLengthM(lengthM: number): number {
  if (lengthM < 900) return 1
  if (lengthM < 1200) return 2
  if (lengthM < 1500) return 3
  if (lengthM < 2400) return 4
  return 6
}

// Annex 14: touchdown-zone pairs are spaced every 150m, the first pair centred 150m from
// the threshold.
const TOUCHDOWN_ZONE_PAIR_SPACING_M = 150

/** Touchdown-zone pair centres, usable-threshold-relative (add `displacedThresholdM` for
 *  the physical-start frame this module otherwise uses). */
export function touchdownZonePairPositionsM(lengthM: number): number[] {
  const count = touchdownZonePairCountForLengthM(lengthM)
  return Array.from({ length: count }, (_, i) => (i + 1) * TOUCHDOWN_ZONE_PAIR_SPACING_M)
}

/**
 * The real "countdown" bar-count pattern within each touchdown-zone group, ordered
 * closest-to-threshold first — not identical single bars at every position, which is what
 * originally shipped here before a real installed-app review caught it. Every real
 * touchdown zone marking group is 1, 2, or 3 rectangular bars on each side of the
 * centreline; the group nearest the threshold gets the most bars, decreasing to a single
 * bar, and the two longest bands (4 and 6 groups) don't invent a new shape per group
 * beyond that: a 4-group runway repeats the single bar for its last group (3,2,1,1 — never
 * a genuinely new count), and a 6-group runway mirrors the taper back up for the far pairs
 * (3,2,1,1,2,3). touchdownZonePairCountForLengthM's own comment already notes there's no
 * 5-group band, so this table has no gap to fill for it.
 */
export function touchdownZoneBarCounts(totalGroups: number): number[] {
  switch (totalGroups) {
    case 1:
      return [1]
    case 2:
      return [2, 1]
    case 3:
      return [3, 2, 1]
    case 4:
      return [3, 2, 1, 1]
    case 6:
      return [3, 2, 1, 1, 2, 3]
    default:
      return Array.from({ length: totalGroups }, () => 1)
  }
}

export interface DiagramLayout {
  /** The visible window along the runway, physical-start frame — exposed mainly for tests;
   *  everything else below is already in px. */
  windowStartM: number
  windowEndM: number
  /** px per metre along the runway's length — the lateral axis uses this times
   *  LATERAL_EXAGGERATION instead (see `touchdown.yPx` below). */
  pxPerM: number
  widthPx: number
  /** The runway's natural height at this layout's scale — callers set the SVG's viewBox
   *  height to this rather than fitting into a fixed one, so LATERAL_EXAGGERATION always
   *  reads consistently regardless of the card's own width. */
  heightPx: number
  /** Where the paved surface starts/ends within the window, in px — before
   *  runwayStartXPx (only possible when the window extends into the -50m tolerance strip)
   *  there's no pavement, just approach area. */
  runwayStartXPx: number
  runwayEndXPx: number
  /** The usable (displacement-adjusted) threshold bar. */
  thresholdXPx: number
  /** The displaced section (physical start to the usable threshold), when one exists. */
  displaced: { startXPx: number; endXPx: number } | null
  thresholdStripeCount: number
  aimingPointXPx: number
  /** One entry per touchdown-zone group, closest-to-threshold first, paired with its real
   *  bar count (touchdownZoneBarCounts) — replaces a flat position list now that groups
   *  aren't all drawn the same way. */
  touchdownZoneGroups: { xPx: number; barCount: number }[]
  touchdownZoneStartXPx: number
  touchdownZoneEndXPx: number
  touchdown: {
    xPx: number
    /** Vertical centre of the dot, already exaggerated per LATERAL_EXAGGERATION and
     *  clamped to the runway edges when the real offset would fall outside them. */
    yPx: number
    /** Where the one-second capture tail starts (behind the dot, i.e. earlier). */
    tailStartXPx: number
    /** True when the real (unclamped) offset falls outside the runway's own half-width —
     *  the dot itself is still drawn, clamped to the edge, but the caller can flag this
     *  distinctly rather than imply a precision the data doesn't have. */
    offRunwayLaterally: boolean
  }
  lateralExaggeration: number
}

/** Lays out one touchdown against one runway end, in px, for a viewport `viewportWidthPx`
 *  wide — the height is derived (see `heightPx` above), not an input. */
export function computeTouchdownDiagramLayout(
  runway: DiagramRunway,
  touchdown: DiagramTouchdown,
  viewportWidthPx: number
): DiagramLayout {
  const touchdownPhysicalM = runway.displacedThresholdM + touchdown.distanceFromThresholdM
  const tailLengthM = Math.max(touchdown.groundSpeedMs, 0) * TOUCHDOWN_CAPTURE_SECONDS
  const tailStartPhysicalM = touchdownPhysicalM - tailLengthM

  const aimingPointPhysicalM = runway.displacedThresholdM + runway.aimingPointDistanceM
  const tdzPairPositionsM = touchdownZonePairPositionsM(runway.lengthM)
  const lastTdzPairPhysicalM = runway.displacedThresholdM + (tdzPairPositionsM.at(-1) ?? 0)
  const touchdownZoneEndPhysicalM = Math.max(aimingPointPhysicalM, lastTdzPairPhysicalM)

  const windowStartM = Math.min(WINDOW_START_MIN_M, tailStartPhysicalM - WINDOW_START_PADDING_M)
  const windowEndM = Math.min(
    runway.lengthM,
    Math.max(touchdownZoneEndPhysicalM, touchdownPhysicalM + WINDOW_END_MARGIN_AFTER_TOUCHDOWN_M)
  )

  const spanM = Math.max(windowEndM - windowStartM, 1)
  const pxPerM = viewportWidthPx / spanM
  const lateralPxPerM = pxPerM * LATERAL_EXAGGERATION
  const heightPx = runway.widthM * lateralPxPerM

  const toXPx = (physicalM: number): number => (physicalM - windowStartM) * pxPerM

  const halfWidthM = runway.widthM / 2
  const offRunwayLaterally = Math.abs(touchdown.centrelineOffsetM) > halfWidthM
  const clampedOffsetM = Math.max(-halfWidthM, Math.min(halfWidthM, touchdown.centrelineOffsetM))

  return {
    windowStartM,
    windowEndM,
    pxPerM,
    widthPx: viewportWidthPx,
    heightPx,
    runwayStartXPx: toXPx(Math.max(windowStartM, 0)),
    runwayEndXPx: toXPx(Math.min(windowEndM, runway.lengthM)),
    thresholdXPx: toXPx(runway.displacedThresholdM),
    displaced:
      runway.displacedThresholdM > 0
        ? { startXPx: toXPx(0), endXPx: toXPx(runway.displacedThresholdM) }
        : null,
    thresholdStripeCount: thresholdStripeCountForWidthM(runway.widthM),
    aimingPointXPx: toXPx(aimingPointPhysicalM),
    touchdownZoneGroups: tdzPairPositionsM.map((m, i) => ({
      xPx: toXPx(runway.displacedThresholdM + m),
      barCount: touchdownZoneBarCounts(tdzPairPositionsM.length)[i]
    })),
    touchdownZoneStartXPx: toXPx(runway.displacedThresholdM),
    touchdownZoneEndXPx: toXPx(touchdownZoneEndPhysicalM),
    touchdown: {
      xPx: toXPx(touchdownPhysicalM),
      yPx: heightPx / 2 + clampedOffsetM * lateralPxPerM,
      tailStartXPx: toXPx(tailStartPhysicalM),
      offRunwayLaterally
    },
    lateralExaggeration: LATERAL_EXAGGERATION
  }
}

/** Evenly spaces `count` positions across `heightPx` (each centred in its own equal
 *  slice) — used to lay the threshold's piano-key stripes out across the runway's width. */
export function evenlySpacedYsPx(count: number, heightPx: number): number[] {
  if (count <= 0) return []
  return Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * heightPx)
}
