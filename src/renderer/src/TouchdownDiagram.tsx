import { useMemo } from 'react'
import type { LandingDistanceUnit, LandingRunway } from '@shared/ipc'
import { computeTouchdownDiagramLayout, evenlySpacedYsPx, type DiagramTouchdown } from './touchdown-diagram'
import { formatCentrelineOffset, formatRunwayDistance } from './units'

// A fixed reference width to lay the geometry out at — the <svg> itself scales to its
// container via viewBox + width="100%", so this only has to be large enough that px-sized
// details (stripe widths, dot radius) look reasonable; it isn't the diagram's real
// on-screen size.
const VIEWPORT_WIDTH_PX = 600

// Fixed regardless of theme (docs/plans/logbook-detail-improvements.md) — runway asphalt
// and markings look the same in daylight whether WingLog itself is in light or dark mode.
const ASPHALT_COLOR = '#3f3f46'
const APPROACH_COLOR = 'var(--color-muted)'
const MARKING_COLOR = '#f8fafc'
const CENTRELINE_COLOR = 'rgba(248, 250, 252, 0.55)'
const DISPLACED_ARROW_COLOR = '#fbbf24'

/** ICAO markings scale with runway size, but a stripe/pair thin enough to vanish at small
 *  sizes reads worse than a slightly-oversized one — these are deliberately floors, not
 *  scaled purely off pxPerM. */
const MIN_STRIPE_LENGTH_PX = 10
const MIN_MARK_LENGTH_PX = 6

/**
 * Everything below is computed in the diagram's natural "along-track, lateral" frame —
 * matching touchdown-diagram.ts's own xPx (along-track)/yPx (lateral) fields — then placed
 * on screen running vertically rather than horizontally (Callum's request, 2026-09-12):
 * landing near the card's bottom, rolling out toward the top, closer to how a pilot looking
 * straight ahead sees a runway extend away, rather than a sideways strip. This is a pure
 * rendering transform; touchdown-diagram.ts's own coordinate frame and tests are untouched.
 * Lateral offset maps directly onto the SVG's X axis (a pilot's right stays screen-right);
 * along-track distance maps onto the SVG's Y axis, flipped (bigger along-track distance ⇒
 * smaller Y ⇒ higher on screen).
 */
function rotatedRect(
  alongStartPx: number,
  alongLengthPx: number,
  lateralCenterPx: number,
  lateralThicknessPx: number,
  widthPx: number
): { x: number; y: number; width: number; height: number } {
  return {
    x: lateralCenterPx - lateralThicknessPx / 2,
    y: widthPx - alongStartPx - alongLengthPx,
    width: lateralThicknessPx,
    height: alongLengthPx
  }
}

function rotatedPoint(alongPx: number, lateralPx: number, widthPx: number): { x: number; y: number } {
  return { x: lateralPx, y: widthPx - alongPx }
}

function ThresholdStripes(props: {
  alongStartPx: number
  count: number
  lateralExtentPx: number
  alongLengthPx: number
  widthPx: number
}): React.JSX.Element {
  const stripeThicknessPx = (props.lateralExtentPx / props.count) * 0.6
  const lanes = evenlySpacedYsPx(props.count, props.lateralExtentPx)
  return (
    <>
      {lanes.map((laneCenterPx, i) => {
        const rect = rotatedRect(
          props.alongStartPx,
          props.alongLengthPx,
          laneCenterPx,
          stripeThicknessPx,
          props.widthPx
        )
        return <rect key={i} {...rect} fill={MARKING_COLOR} />
      })}
    </>
  )
}

/**
 * One touchdown-zone-style marking group — the real ICAO/FAA "countdown" pattern (see
 * touchdown-diagram.ts's touchdownZoneBarCounts): `barCount` bars stacked outward from the
 * centreline on each side, not just one pair regardless of position. The aiming point
 * marking reuses this with barCount=1 and bigger dimensions, since it's the one always-
 * prominent marking rather than part of the countdown.
 */
function TouchdownZoneGroup(props: {
  alongStartPx: number
  alongLengthPx: number
  barCount: number
  barThicknessPx: number
  barSpacingPx: number
  centreGapPx: number
  lateralExtentPx: number
  widthPx: number
}): React.JSX.Element {
  const bars: { rect: { x: number; y: number; width: number; height: number }; key: string }[] = []
  const centreY = props.lateralExtentPx / 2
  for (const side of [-1, 1]) {
    for (let i = 0; i < props.barCount; i++) {
      const innerEdgeDistancePx = props.centreGapPx + i * (props.barThicknessPx + props.barSpacingPx)
      const laneCenterPx = centreY + side * (innerEdgeDistancePx + props.barThicknessPx / 2)
      bars.push({
        key: `${side}-${i}`,
        rect: rotatedRect(props.alongStartPx, props.alongLengthPx, laneCenterPx, props.barThicknessPx, props.widthPx)
      })
    }
  }
  return (
    <>
      {bars.map(({ key, rect }) => (
        <rect key={key} {...rect} fill={MARKING_COLOR} />
      ))}
    </>
  )
}

/**
 * Logbook's touchdown diagram (docs/plans/logbook-detail-improvements.md) — a short,
 * to-scale stretch of the runway the aircraft actually landed on, with standard ICAO
 * markings, showing where the touchdown fell relative to the touchdown zone. Drawn as
 * inline SVG (no new dependency) from computeTouchdownDiagramLayout's pure geometry.
 *
 * The stored touchdown position is up to one second late and refers to the aircraft's
 * reference point, not its main gear (landing-capture.ts's own doc comment) — the tail
 * behind the dot represents that one-second window rather than implying more precision
 * than the data has.
 */
export function TouchdownDiagram(props: {
  runway: LandingRunway
  touchdown: DiagramTouchdown
  unit: LandingDistanceUnit
}): React.JSX.Element {
  const layout = useMemo(
    () => computeTouchdownDiagramLayout(props.runway, props.touchdown, VIEWPORT_WIDTH_PX),
    [props.runway, props.touchdown]
  )

  const stripeLengthPx = Math.max(MIN_STRIPE_LENGTH_PX, 30 * layout.pxPerM)
  const aimingPointLengthPx = Math.max(MIN_MARK_LENGTH_PX, 22 * layout.pxPerM)
  const tdzGroupLengthPx = Math.max(MIN_MARK_LENGTH_PX, 18 * layout.pxPerM)
  const dotRadiusPx = Math.max(4, Math.min(7, layout.heightPx * 0.08))

  // svgWidthPx/svgHeightPx are the on-screen dimensions after rotation — the diagram's
  // lateral extent (layout.heightPx) becomes the SVG's width, and its along-track extent
  // (layout.widthPx) becomes the SVG's height.
  const svgWidthPx = layout.heightPx
  const svgHeightPx = layout.widthPx

  const runwayBandLengthPx = Math.max(0, layout.runwayEndXPx - layout.runwayStartXPx)
  const tdzShadingLengthPx = Math.max(0, layout.touchdownZoneEndXPx - layout.touchdownZoneStartXPx)

  const tail = rotatedPoint(layout.touchdown.tailStartXPx, layout.touchdown.yPx, layout.widthPx)
  const dot = rotatedPoint(layout.touchdown.xPx, layout.touchdown.yPx, layout.widthPx)

  return (
    <div className="flex flex-col gap-1.5">
      <svg
        viewBox={`0 0 ${svgWidthPx} ${svgHeightPx}`}
        width="100%"
        height="auto"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Touchdown diagram for runway ${props.runway.ident}`}
      >
        {/* Approach area before the physical runway start, when the window extends into it. */}
        {layout.runwayStartXPx > 0 && (
          <rect {...rotatedRect(0, layout.runwayStartXPx, svgWidthPx / 2, svgWidthPx, layout.widthPx)} fill={APPROACH_COLOR} />
        )}

        {/* Runway surface. */}
        <rect
          {...rotatedRect(layout.runwayStartXPx, runwayBandLengthPx, svgWidthPx / 2, svgWidthPx, layout.widthPx)}
          fill={ASPHALT_COLOR}
        />

        {/* Touchdown zone shading — "the" touchdown zone for now (landing-scoring.md defines
            a scored "ideal" zone separately, shown in the score-breakdown popup instead). */}
        <rect
          {...rotatedRect(
            layout.touchdownZoneStartXPx,
            tdzShadingLengthPx,
            svgWidthPx / 2,
            svgWidthPx,
            layout.widthPx
          )}
          fill="var(--color-primary)"
          opacity={0.12}
        />

        {/* Displaced threshold: arrows across the displaced section, ending at the usable
            threshold bar. */}
        {layout.displaced && (
          <line
            x1={svgWidthPx / 2}
            y1={layout.widthPx - layout.displaced.startXPx}
            x2={svgWidthPx / 2}
            y2={layout.widthPx - layout.displaced.endXPx}
            stroke={DISPLACED_ARROW_COLOR}
            strokeWidth={Math.max(2, svgWidthPx * 0.04)}
            strokeDasharray="6 4"
          />
        )}

        {/* Usable threshold bar. */}
        <rect
          {...rotatedRect(
            Math.max(layout.runwayStartXPx, layout.thresholdXPx - 1),
            2,
            svgWidthPx / 2,
            svgWidthPx,
            layout.widthPx
          )}
          fill={MARKING_COLOR}
        />

        {/* Threshold piano keys. */}
        <ThresholdStripes
          alongStartPx={layout.thresholdXPx + 3}
          count={layout.thresholdStripeCount}
          lateralExtentPx={svgWidthPx}
          alongLengthPx={stripeLengthPx}
          widthPx={layout.widthPx}
        />

        {/* Touchdown-zone marking groups — the real 3/2/1 "countdown" bar pattern. */}
        {layout.touchdownZoneGroups.map((group, i) => (
          <TouchdownZoneGroup
            key={i}
            alongStartPx={group.xPx}
            alongLengthPx={tdzGroupLengthPx}
            barCount={group.barCount}
            barThicknessPx={svgWidthPx * 0.07}
            barSpacingPx={svgWidthPx * 0.03}
            centreGapPx={svgWidthPx * 0.1}
            lateralExtentPx={svgWidthPx}
            widthPx={layout.widthPx}
          />
        ))}

        {/* Aiming point marking — drawn last (on top) and bigger, since it's the
            prominent one, always a single bar per side regardless of runway length. */}
        <TouchdownZoneGroup
          alongStartPx={layout.aimingPointXPx}
          alongLengthPx={aimingPointLengthPx}
          barCount={1}
          barThicknessPx={svgWidthPx * 0.22}
          barSpacingPx={0}
          centreGapPx={svgWidthPx * 0.11}
          lateralExtentPx={svgWidthPx}
          widthPx={layout.widthPx}
        />

        {/* Centreline. */}
        <line
          x1={svgWidthPx / 2}
          y1={layout.widthPx - layout.runwayStartXPx}
          x2={svgWidthPx / 2}
          y2={layout.widthPx - layout.runwayEndXPx}
          stroke={CENTRELINE_COLOR}
          strokeWidth={Math.max(1, svgWidthPx * 0.015)}
          strokeDasharray="10 6"
        />

        {/* Touchdown tail (the one-second capture window) and dot. */}
        <line
          x1={tail.x}
          y1={tail.y}
          x2={dot.x}
          y2={dot.y}
          stroke={layout.touchdown.offRunwayLaterally ? 'var(--color-destructive)' : 'var(--color-primary)'}
          strokeWidth={Math.max(2, dotRadiusPx * 0.5)}
          strokeLinecap="round"
          opacity={0.6}
        />
        <circle
          cx={dot.x}
          cy={dot.y}
          r={dotRadiusPx}
          fill={layout.touchdown.offRunwayLaterally ? 'var(--color-destructive)' : 'var(--color-primary)'}
          stroke={MARKING_COLOR}
          strokeWidth={1.5}
        />
      </svg>

      <p className="text-xs text-muted-foreground">
        {formatRunwayDistance(props.touchdown.distanceFromThresholdM, props.unit)} from threshold,{' '}
        {formatCentrelineOffset(props.touchdown.centrelineOffsetM, props.unit)} · aiming point{' '}
        {formatRunwayDistance(props.runway.aimingPointDistanceM, props.unit)} · lateral scale ×
        {layout.lateralExaggeration} · exact touchdown point is within ~1s of ground roll behind the dot
      </p>
    </div>
  )
}
