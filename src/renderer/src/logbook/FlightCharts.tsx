/** The flight detail page's charts: altitude, speed, and planned versus actual fuel. */

import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { WeightUnit } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatWeight } from '../units'
import type { FlightProfile } from './use-flight-detail'

// Recharts SVG props take any CSS color, including our design-token custom properties —
// this keeps the charts on the same palette as the rest of the app instead of hardcoded hex.
const CHART_GRID_COLOR = 'var(--color-border)'
const CHART_AXIS_COLOR = 'var(--color-muted-foreground)'
const CHART_SERIES_1 = 'var(--color-primary)'
const CHART_SERIES_2 = 'var(--color-success)'
const CHART_TOOLTIP_STYLE = {
  background: 'var(--color-popover)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  color: 'var(--color-popover-foreground)',
  fontSize: '0.8rem'
}

/**
 * Recharts' default tooltip puts the hovered time on its own header line and the value
 * below it — but the time is already readable straight off the axis (the vertical cursor
 * line still shows exactly where the hover is), so the header line just adds noise. This
 * shows only the formatted value, in the numeric-readout mono style used everywhere else
 * in the app (docs/plans/logbook-detail-improvements.md, item 2).
 *
 * @param props The chart's tooltip state, and how to format the value.
 * @returns The tooltip, or null when inactive.
 */
function ValueTooltip(props: {
  active?: boolean
  payload?: readonly { value?: number | string }[]
  formatValue: (value: number) => string
}): React.JSX.Element | null {
  if (!props.active || !props.payload || props.payload.length === 0) return null
  const raw = props.payload[0]?.value
  if (typeof raw !== 'number') return null
  return (
    <div style={CHART_TOOLTIP_STYLE} className="px-2 py-1 font-mono text-sm tabular-nums">
      {props.formatValue(raw)}
    </div>
  )
}

/**
 * Altitude against elapsed time.
 *
 * @param props The profile with its time axis.
 * @returns The element.
 */
export function AltitudeChart(props: { profile: FlightProfile }): React.JSX.Element {
  const { t } = useTranslation()
  const { profile, altitudeChartLabel, ticksMin, timeAxisUnit, formatTimeTick } = props.profile
  return (
    <Card className="min-w-72 flex-1">
      <CardHeader>
        <CardTitle className="text-sm">
          {altitudeChartLabel === 'True altitude' ? t('logbookView.trueAltitude') : t('logbookView.altitude')}
        </CardTitle>
      </CardHeader>
      <CardContent className="h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={profile}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
            <XAxis
              dataKey="tMin"
              type="number"
              domain={[0, 'dataMax']}
              ticks={ticksMin}
              tickFormatter={formatTimeTick}
              unit={timeAxisUnit}
              stroke={CHART_AXIS_COLOR}
              tick={{ fill: CHART_AXIS_COLOR }}
            />
            <YAxis
              unit=" ft"
              width={70}
              stroke={CHART_AXIS_COLOR}
              tick={{ fill: CHART_AXIS_COLOR }}
              tickFormatter={(v: number) => v.toLocaleString()}
            />
            <Tooltip content={<ValueTooltip formatValue={(v) => `${Math.round(v).toLocaleString()} ft`} />} />
            <Line
              type="monotone"
              dataKey="altFt"
              stroke={CHART_SERIES_1}
              dot={false}
              name="Altitude"
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

/**
 * Indicated airspeed or Mach against elapsed time, with the switch between the two.
 *
 * @param props The profile with its time axis, the chosen mode, and the handler that changes it.
 * @returns The element.
 */
export function SpeedChart(props: {
  profile: FlightProfile
  speedMode: 'ias' | 'mach'
  onSpeedModeChange: (mode: 'ias' | 'mach') => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { profile, ticksMin, timeAxisUnit, formatTimeTick } = props.profile
  const { speedMode } = props
  const speedDataKey = speedMode === 'ias' ? 'iasKt' : 'mach'
  return (
    <Card className="min-w-72 flex-1">
      <CardHeader>
        <CardTitle className="text-sm">
          {t('logbookView.speedTitle', { mode: speedMode === 'ias' ? 'IAS' : 'Mach' })}
        </CardTitle>
        <CardAction>
          <div className="flex gap-1">
            <Button
              type="button"
              variant={speedMode === 'ias' ? 'default' : 'outline'}
              size="sm"
              onClick={() => props.onSpeedModeChange('ias')}
            >
              IAS
            </Button>
            <Button
              type="button"
              variant={speedMode === 'mach' ? 'default' : 'outline'}
              size="sm"
              onClick={() => props.onSpeedModeChange('mach')}
            >
              Mach
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={profile}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
            <XAxis
              dataKey="tMin"
              type="number"
              domain={[0, 'dataMax']}
              ticks={ticksMin}
              tickFormatter={formatTimeTick}
              unit={timeAxisUnit}
              stroke={CHART_AXIS_COLOR}
              tick={{ fill: CHART_AXIS_COLOR }}
            />
            <YAxis
              unit={speedMode === 'ias' ? ' kt' : ''}
              width={60}
              stroke={CHART_AXIS_COLOR}
              tick={{ fill: CHART_AXIS_COLOR }}
              tickFormatter={
                speedMode === 'mach' ? (v: number) => v.toFixed(2) : (v: number) => v.toLocaleString()
              }
            />
            <Tooltip
              content={
                <ValueTooltip
                  formatValue={(v) =>
                    speedMode === 'ias' ? `${Math.round(v).toLocaleString()} kt` : `M${v.toFixed(2)}`
                  }
                />
              }
            />
            <Line
              type="monotone"
              dataKey={speedDataKey}
              stroke={CHART_SERIES_2}
              dot={false}
              name={speedMode === 'ias' ? 'IAS' : 'Mach'}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

/**
 * Planned against actual fuel burn, as two bars.
 *
 * @param props The fuel figures and the weight unit.
 * @returns The element.
 */
export function FuelChart(props: {
  data: { name: string; kg: number }[]
  weightUnit: WeightUnit
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Card className="min-w-72 max-w-96 flex-1">
      <CardHeader>
        <CardTitle className="text-sm">{t('logbookView.fuelPlannedVsActual')}</CardTitle>
      </CardHeader>
      <CardContent className="h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={props.data}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
            <XAxis dataKey="name" stroke={CHART_AXIS_COLOR} tick={{ fill: CHART_AXIS_COLOR }} />
            <YAxis width={60} stroke={CHART_AXIS_COLOR} tick={{ fill: CHART_AXIS_COLOR }} />
            <Tooltip
              formatter={(value) => formatWeight(Number(value), props.weightUnit)}
              contentStyle={CHART_TOOLTIP_STYLE}
            />
            <Bar dataKey="kg" fill={CHART_SERIES_1} name="Fuel" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
