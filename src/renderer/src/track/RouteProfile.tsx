/** The altitude profile of the planned route under Track's map (winglog-backend docs/plans/v2-design.md, "Track"). */

import { useTranslation } from 'react-i18next'
import type { AltitudeUnit } from '@shared/ipc'
import { distanceAlongRoute, routeProfile } from '@shared/route-profile'
import type { Waypoint } from '@shared/route'
import { formatAltitude } from '../units'

const WIDTH = 600
const HEIGHT = 84
const PAD_LEFT = 4
const PAD_RIGHT = 4
const PAD_TOP = 14
const PAD_BOTTOM = 6

/**
 * The plan's altitude against the distance along the route: a thin dashed magenta line (the plan), and the aircraft's own place on it
 * in ink. It draws what the waypoints carry: fixes with no planned altitude are left out of the line.
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
  const profile = routeProfile(props.waypoints)
  if (!profile || profile.maxAltitudeFt <= 0 || profile.totalNm <= 0) return null
  const top = profile.maxAltitudeFt * 1.1
  const x = (nm: number): number => PAD_LEFT + (nm / profile.totalNm) * (WIDTH - PAD_LEFT - PAD_RIGHT)
  const y = (ft: number): number => HEIGHT - PAD_BOTTOM - (ft / top) * (HEIGHT - PAD_TOP - PAD_BOTTOM)
  const line = profile.points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${x(point.distanceNm).toFixed(1)} ${y(point.altitudeFt).toFixed(1)}`
    )
    .join(' ')
  const along = props.aircraft
    ? distanceAlongRoute(props.waypoints, profile.cumulativeNm, [props.aircraft.lon, props.aircraft.lat])
    : null
  return (
    <figure className="m-0 flex flex-col gap-0.5" data-testid="route-profile">
      <figcaption className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{t('trackView.profile.title')}</span>
        <span className="font-mono">
          {formatAltitude(profile.maxAltitudeFt, props.altitudeUnit ?? 'ft')} ·{' '}
          {Math.round(profile.totalNm).toLocaleString()} nm
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('trackView.profile.title')}
        className="h-20 w-full rounded-md bg-card"
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
    </figure>
  )
}
