/** The flight detail page's charts: altitude, speed, and planned versus actual fuel (the canvas's r3-flight). */

import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { WeightUnit } from '@shared/ipc'
import { SegmentButton, SegmentedGroup } from '../settings/ui/SettingsCard'
import { formatWeight } from '../units'
import type { FlightProfile } from './use-flight-detail'

// Recharts SVG props take any CSS color, including our design-token custom properties — this keeps the charts on the same palette as the
// rest of the app: what was flown in the text colour, a thick line, with hairline gridlines and the axes in the mono face.
const CHART_GRID_COLOR = 'var(--color-border)'
const CHART_AXIS_COLOR = 'var(--color-muted-foreground)'
const CHART_FLOWN_COLOR = 'var(--color-foreground)'
const CHART_TICK = { fill: CHART_AXIS_COLOR, fontSize: 11, fontFamily: 'var(--font-mono)' }
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
 * A chart's section: its title (with something on the right of it, when there is something), then the chart under it.
 *
 * @param props The title, what sits on the right of it, and the chart.
 * @returns The element.
 */
function ChartSection(props: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="min-w-0 flex-[1_1_28rem]" aria-label={props.title}>
      <div className="flex min-h-9 items-center justify-between gap-3 pb-2">
        <h3 className="m-0 text-[17px] font-semibold">{props.title}</h3>
        {props.aside}
      </div>
      <div className="h-[230px]">{props.children}</div>
    </section>
  )
}

/**
 * One flown line against elapsed time.
 *
 * @param props The profile, the value each point has, the axis label and format, and the tooltip's format.
 * @returns The element.
 */
function FlownLineChart(props: {
  profile: FlightProfile
  dataKey: string
  name: string
  yUnit: string
  yWidth: number
  formatTick: (value: number) => string
  formatValue: (value: number) => string
}): React.JSX.Element {
  const { profile, ticksMin, timeAxisUnit, formatTimeTick } = props.profile
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={profile}>
        <CartesianGrid vertical={false} stroke={CHART_GRID_COLOR} />
        <XAxis
          dataKey="tMin"
          type="number"
          domain={[0, 'dataMax']}
          ticks={ticksMin}
          tickFormatter={formatTimeTick}
          unit={timeAxisUnit}
          stroke={CHART_GRID_COLOR}
          tick={CHART_TICK}
        />
        <YAxis
          unit={props.yUnit}
          width={props.yWidth}
          axisLine={false}
          tickLine={false}
          tick={CHART_TICK}
          tickFormatter={props.formatTick}
        />
        <Tooltip content={<ValueTooltip formatValue={props.formatValue} />} />
        <Line
          type="monotone"
          dataKey={props.dataKey}
          stroke={CHART_FLOWN_COLOR}
          strokeWidth={2.4}
          dot={false}
          name={props.name}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
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
  const title =
    props.profile.altitudeChartLabel === 'True altitude'
      ? t('logbookView.trueAltitude')
      : t('logbookView.altitude')
  return (
    <ChartSection title={title}>
      <FlownLineChart
        profile={props.profile}
        dataKey="altFt"
        name="Altitude"
        yUnit=" ft"
        yWidth={70}
        formatTick={(v) => v.toLocaleString()}
        formatValue={(v) => `${Math.round(v).toLocaleString()} ft`}
      />
    </ChartSection>
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
  const { speedMode } = props
  return (
    <ChartSection
      title={t('logbookView.speedTitle', { mode: speedMode === 'ias' ? 'IAS' : 'Mach' })}
      aside={
        <SegmentedGroup label={t('logbookView.speedMode')}>
          <SegmentButton pressed={speedMode === 'ias'} onClick={() => props.onSpeedModeChange('ias')}>
            IAS
          </SegmentButton>
          <SegmentButton pressed={speedMode === 'mach'} onClick={() => props.onSpeedModeChange('mach')}>
            Mach
          </SegmentButton>
        </SegmentedGroup>
      }
    >
      <FlownLineChart
        profile={props.profile}
        dataKey={speedMode === 'ias' ? 'iasKt' : 'mach'}
        name={speedMode === 'ias' ? 'IAS' : 'Mach'}
        yUnit={speedMode === 'ias' ? ' kt' : ''}
        yWidth={60}
        formatTick={speedMode === 'mach' ? (v) => v.toFixed(2) : (v) => v.toLocaleString()}
        formatValue={(v) =>
          speedMode === 'ias' ? `${Math.round(v).toLocaleString()} kt` : `M${v.toFixed(2)}`
        }
      />
    </ChartSection>
  )
}

/**
 * Planned against actual fuel burn, as two bars: the plan's in magenta, what was burned in the text colour.
 *
 * @param props The fuel figures and the weight unit.
 * @returns The element.
 */
export function FuelChart(props: {
  data: { name: string; kg: number }[]
  weightUnit: WeightUnit
}): React.JSX.Element {
  const { t } = useTranslation()
  const most = Math.max(...props.data.map((d) => d.kg), 1)
  return (
    <section className="min-w-0 flex-[1_1_26rem]" aria-label={t('logbookView.fuelPlannedVsActual')}>
      <h3 className="m-0 pb-2 text-[17px] font-semibold">{t('logbookView.fuelPlannedVsActual')}</h3>
      {props.data.map((row, index) => {
        const planned = index === 0
        return (
          <div
            key={row.name}
            className={`grid min-h-9 grid-cols-[5rem_minmax(0,1fr)_6rem] items-center gap-3 border-t border-border ${planned ? 'text-plan' : ''}`}
          >
            <span className="text-muted-foreground">{row.name}</span>
            <span className="h-2 rounded-sm bg-border" aria-hidden="true">
              <span
                className={`block h-2 rounded-sm ${planned ? 'bg-plan' : 'bg-foreground'}`}
                style={{ width: `${(row.kg / most) * 100}%` }}
              />
            </span>
            <span className={`text-right font-mono ${planned ? 'text-plan' : 'text-foreground'}`}>
              {formatWeight(row.kg, props.weightUnit)}
            </span>
          </div>
        )
      })}
    </section>
  )
}
