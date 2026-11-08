/** The altitude profile of the planned route under Track's map (winglog-backend docs/plans/v2-design.md, "Track"). */

import { ArrowUp } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AltitudeUnit } from '@shared/ipc'
import type { ProfilePoint, RouteProfile as Profile } from '@shared/route-profile'
import { clipProfile, distanceAlongRoute, routeProfile, stepClimbs, zoomWindow } from '@shared/route-profile'
import type { Waypoint } from '@shared/route'
import { SegmentButton, SegmentedGroup } from '../settings/ui/SettingsCard'
import { formatAltitude } from '../units'

/** How much of the route is shown: all of it, or this many nautical miles around the aircraft. */
type Zoom = 'route' | 250 | 100
const ZOOMS: Zoom[] = ['route', 250, 100]

const WIDTH = 600
const HEIGHT = 84
const PAD_LEFT = 4
const PAD_RIGHT = 4
const PAD_TOP = 14
const PAD_BOTTOM = 6

/**
 * The choice of how much of the route the profile shows.
 *
 * @param props The chosen zoom and the handler that changes it.
 * @returns The element.
 */
function ZoomControl(props: { zoom: Zoom; onChange: (zoom: Zoom) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SegmentedGroup label={t('trackView.profile.zoom')}>
      {ZOOMS.map((level) => (
        <SegmentButton
          key={level}
          compact
          pressed={props.zoom === level}
          onClick={() => props.onChange(level)}
        >
          {level === 'route' ? t('trackView.profile.wholeRoute') : `${level} nm`}
        </SegmentButton>
      ))}
    </SegmentedGroup>
  )
}

/**
 * @param profile The planned route's profile.
 * @param zoom How much of the route to show.
 * @param along How far along the route the aircraft is, when it is on it.
 * @param aircraftFt The aircraft's altitude, so it is never drawn off the top.
 * @returns Whether the profile is zoomed, the stretch of the route shown, the points of the line in it, and the height it is scaled to.
 */
function visibleStretch(
  profile: Profile,
  zoom: Zoom,
  along: number | null,
  aircraftFt: number
): { zoomed: boolean; view: { fromNm: number; toNm: number }; points: ProfilePoint[]; highestFt: number } {
  const zoomed = along !== null && zoom !== 'route'
  const view = zoomed ? zoomWindow(profile.totalNm, along, zoom) : { fromNm: 0, toNm: profile.totalNm }
  const points = zoomed ? clipProfile(profile.points, view.fromNm, view.toNm) : profile.points
  return { zoomed, view, points, highestFt: Math.max(...points.map((p) => p.altitudeFt), aircraftFt, 1) }
}

/**
 * The plan's altitude against the distance along the route: a thin dashed magenta line (the plan), and the aircraft's own place on it
 * in ink, and a small up arrow above the line where each planned step climb starts. It draws what the waypoints carry: fixes with no planned altitude are left out of the line. While the aircraft is on the
 * route it can be zoomed to the stretch around it: the next 250 or 100 nm, with the height scaled to that stretch.
 *
 * @param props The planned waypoints, the aircraft's position and altitude when it is flying, and the altitude unit.
 * @returns The element, or nothing when the route has too little altitude to draw.
 */
export function RouteProfile(props: {
  waypoints: Waypoint[]
  aircraft: { lon: number; lat: number; altitudeFt: number } | null
  altitudeUnit?: AltitudeUnit
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [zoom, setZoom] = useState<Zoom>('route')
  const profile = routeProfile(props.waypoints)
  if (!profile || profile.maxAltitudeFt <= 0 || profile.totalNm <= 0) return null
  const along = props.aircraft
    ? distanceAlongRoute(props.waypoints, profile.cumulativeNm, [props.aircraft.lon, props.aircraft.lat])
    : null
  const { zoomed, view, points, highestFt } = visibleStretch(
    profile,
    zoom,
    along,
    props.aircraft?.altitudeFt ?? 0
  )
  const top = highestFt * 1.1
  const x = (nm: number): number =>
    PAD_LEFT + ((nm - view.fromNm) / (view.toNm - view.fromNm)) * (WIDTH - PAD_LEFT - PAD_RIGHT)
  const y = (ft: number): number => HEIGHT - PAD_BOTTOM - (ft / top) * (HEIGHT - PAD_TOP - PAD_BOTTOM)
  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${x(point.distanceNm).toFixed(1)} ${y(point.altitudeFt).toFixed(1)}`
    )
    .join(' ')
  const steps = stepClimbs(profile.points).filter((s) => s.atNm >= view.fromNm && s.atNm <= view.toNm)
  return (
    <figure
      className="m-0 flex flex-col gap-1 rounded-b-md border-t-[3px] border-foreground bg-card px-4 pt-2.5 pb-3"
      data-testid="route-profile"
    >
      <figcaption className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="font-display text-[17px] leading-snug font-bold tracking-[-0.01em] text-foreground">
          {t('trackView.profile.title')}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          <span className="font-mono">
            {formatAltitude(zoomed ? highestFt : profile.maxAltitudeFt, props.altitudeUnit ?? 'ft')} ·{' '}
            {Math.round(zoomed ? view.toNm - view.fromNm : profile.totalNm).toLocaleString()} nm
          </span>
          {along !== null && <ZoomControl zoom={zoom} onChange={setZoom} />}
        </span>
      </figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t('trackView.profile.title')}
          className="h-20 w-full"
        >
          <line
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--border)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={line}
            fill="none"
            stroke="var(--plan)"
            strokeWidth="1.5"
            strokeDasharray="6 4"
            vectorEffect="non-scaling-stroke"
            data-testid="route-profile-plan"
          />
          {props.aircraft && along !== null && (
            <circle
              cx={x(along)}
              cy={y(Math.min(Math.max(props.aircraft.altitudeFt, 0), top))}
              r="4"
              fill="var(--foreground)"
              data-testid="route-profile-aircraft"
            />
          )}
        </svg>
        {steps.map((step) => (
          // An HTML arrow over the chart: the chart is stretched to its width, which would squash a drawn one.
          <ArrowUp
            key={step.atNm}
            aria-label={t('trackView.profile.stepClimb', {
              altitude: formatAltitude(step.toFt, props.altitudeUnit ?? 'ft')
            })}
            role="img"
            aria-hidden={false}
            data-testid="route-profile-step"
            strokeWidth={2.5}
            className="absolute size-3 -translate-x-1/2 -translate-y-full text-plan"
            style={{
              left: `${(x(step.atNm) / WIDTH) * 100}%`,
              top: `${((y(step.fromFt) - 2) / HEIGHT) * 100}%`
            }}
          />
        ))}
      </div>
    </figure>
  )
}
