import { useMemo } from 'react'
import type { LandingDistanceUnit, LandingRunway } from '@shared/ipc'
import {
  computeTouchdownDiagramLayout,
  evenlySpacedYsPx,
  type DiagramTouchdown
} from './touchdown-diagram'
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

function ThresholdStripes(props: { xPx: number; count: number; heightPx: number; lengthPx: number }): React.JSX.Element {
  const stripeHeightPx = (props.heightPx / props.count) * 0.6
  const ys = evenlySpacedYsPx(props.count, props.heightPx)
  return (
    <>
      {ys.map((yPx, i) => (
        <rect
          key={i}
          x={props.xPx}
          y={yPx - stripeHeightPx / 2}
          width={props.lengthPx}
          height={stripeHeightPx}
          fill={MARKING_COLOR}
        />
      ))}
    </>
  )
}

/** One touchdown-zone-style marking pair — used for both the aiming point (bigger) and
 *  the plain touchdown-zone pairs (smaller), which share the same "two blocks straddling
 *  the centreline" shape in the real ICAO markings. */
function MarkingPair(props: { xPx: number; heightPx: number; lengthPx: number; barHeightPx: number; gapPx: number }): React.JSX.Element {
  const centreY = props.heightPx / 2
  const topY = centreY - props.gapPx / 2 - props.barHeightPx
  const bottomY = centreY + props.gapPx / 2
  return (
    <>
      <rect x={props.xPx} y={topY} width={props.lengthPx} height={props.barHeightPx} fill={MARKING_COLOR} />
      <rect x={props.xPx} y={bottomY} width={props.lengthPx} height={props.barHeightPx} fill={MARKING_COLOR} />
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
  const tdzPairLengthPx = Math.max(MIN_MARK_LENGTH_PX, 18 * layout.pxPerM)
  const dotRadiusPx = Math.max(4, Math.min(7, layout.heightPx * 0.08))

  return (
    <div className="flex flex-col gap-1.5">
      <svg
        viewBox={`0 0 ${layout.widthPx} ${layout.heightPx}`}
        width="100%"
        height="auto"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Touchdown diagram for runway ${props.runway.ident}`}
      >
        {/* Approach area before the physical runway start, when the window extends into it. */}
        {layout.runwayStartXPx > 0 && (
          <rect x={0} y={0} width={layout.runwayStartXPx} height={layout.heightPx} fill={APPROACH_COLOR} />
        )}

        {/* Runway surface. */}
        <rect
          x={layout.runwayStartXPx}
          y={0}
          width={Math.max(0, layout.runwayEndXPx - layout.runwayStartXPx)}
          height={layout.heightPx}
          fill={ASPHALT_COLOR}
        />

        {/* Touchdown zone shading — "the" touchdown zone for now (landing-scoring.md will
            define a scored "ideal" zone later). */}
        <rect
          x={layout.touchdownZoneStartXPx}
          y={0}
          width={Math.max(0, layout.touchdownZoneEndXPx - layout.touchdownZoneStartXPx)}
          height={layout.heightPx}
          fill="var(--color-primary)"
          opacity={0.12}
        />

        {/* Displaced threshold: arrows across the displaced section, ending at the usable
            threshold bar. */}
        {layout.displaced && (
          <line
            x1={layout.displaced.startXPx}
            y1={layout.heightPx / 2}
            x2={layout.displaced.endXPx}
            y2={layout.heightPx / 2}
            stroke={DISPLACED_ARROW_COLOR}
            strokeWidth={Math.max(2, layout.heightPx * 0.04)}
            strokeDasharray="6 4"
          />
        )}

        {/* Usable threshold bar. */}
        <rect
          x={Math.max(layout.runwayStartXPx, layout.thresholdXPx - 1)}
          y={0}
          width={2}
          height={layout.heightPx}
          fill={MARKING_COLOR}
        />

        {/* Threshold piano keys. */}
        <ThresholdStripes
          xPx={layout.thresholdXPx + 3}
          count={layout.thresholdStripeCount}
          heightPx={layout.heightPx}
          lengthPx={stripeLengthPx}
        />

        {/* Touchdown-zone marking pairs. */}
        {layout.touchdownZonePairXsPx.map((xPx, i) => (
          <MarkingPair
            key={i}
            xPx={xPx}
            heightPx={layout.heightPx}
            lengthPx={tdzPairLengthPx}
            barHeightPx={layout.heightPx * 0.12}
            gapPx={layout.heightPx * 0.3}
          />
        ))}

        {/* Aiming point marking — drawn last (on top) and bigger, since it's the
            prominent one. */}
        <MarkingPair
          xPx={layout.aimingPointXPx}
          heightPx={layout.heightPx}
          lengthPx={aimingPointLengthPx}
          barHeightPx={layout.heightPx * 0.22}
          gapPx={layout.heightPx * 0.22}
        />

        {/* Centreline. */}
        <line
          x1={layout.runwayStartXPx}
          y1={layout.heightPx / 2}
          x2={layout.runwayEndXPx}
          y2={layout.heightPx / 2}
          stroke={CENTRELINE_COLOR}
          strokeWidth={Math.max(1, layout.heightPx * 0.015)}
          strokeDasharray="10 6"
        />

        {/* Touchdown tail (the one-second capture window) and dot. */}
        <line
          x1={layout.touchdown.tailStartXPx}
          y1={layout.touchdown.yPx}
          x2={layout.touchdown.xPx}
          y2={layout.touchdown.yPx}
          stroke={layout.touchdown.offRunwayLaterally ? 'var(--color-destructive)' : 'var(--color-primary)'}
          strokeWidth={Math.max(2, dotRadiusPx * 0.5)}
          strokeLinecap="round"
          opacity={0.6}
        />
        <circle
          cx={layout.touchdown.xPx}
          cy={layout.touchdown.yPx}
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
