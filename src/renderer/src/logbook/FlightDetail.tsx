/** A flight's detail page: summary, map, charts and landing. */

import { useEffect, useMemo, useState } from 'react'
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
import { ArrowLeft, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  Aircraft,
  Flight,
  LogbookFlight,
  LandingDistanceUnit,
  MapLanguage,
  TrackPoint,
  WeightUnit
} from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AddFlightToFleetDialog } from '../AddFlightToFleetDialog'
import { computeChartAxisTicks, formatTickLabel } from '../chart-ticks'
import { displayAltitude } from '../display-altitude'
import { displayIcao } from '../display-icao'
import { FlightMap } from '../FlightMap'
import { GsxInvoicesCard } from '../GsxInvoicesCard'
import { useConfirm } from '../hooks/useConfirm'
import { selectionFromFlight, useLiveWaypoints } from '../procedureSelection'
import { parseTransitionAltitudes, type Waypoint } from '../route'
import { KeepCaptureButton } from '../KeepCaptureButton'
import { TrackCleanupButton } from '../TrackCleanupButton'
import { formatMinutes, formatWeight, msToKt } from '../units'
import { asyncHandler, runAsync } from '../report-error'
import { formatDate, isFreeFlight } from './logbook-format'
import { DETAIL_GRID_CLASS, DetailField } from './DetailField'
import { LandingCard } from './LandingCard'

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
// Past this, a minutes axis on a long-haul chart reads as a wall of three-digit ticks
// (e.g. "540 min") — hours read at a glance instead. Below it, a short flight's duration
// in hours would round to one or two ticks total, which is worse than minutes, not better.
const HOURS_AXIS_THRESHOLD_MIN = 90

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
 * Fetches the opened flight in full (OFP included) before showing it — the list rows are
 * LogbookFlight, which leave the ~90 KB OFP out (see LogbookFlight in ipc.ts).
 *
 * @param props FlightDetail's props, with the list row instead of the full flight.
 * @returns The element.
 */
export function FlightDetailLoader(
  props: Omit<React.ComponentProps<typeof FlightDetail>, 'flight'> & {
    /** The list's own row for this flight. A new object every time the list reloads (after
     *  linking an aircraft, say), which re-fetches the full flight so the detail never shows
     *  a stale copy — real bug caught by free-flight.spec.ts while building this. */
    listRow: LogbookFlight
  }
): React.JSX.Element {
  const { t } = useTranslation()
  const { listRow, ...rest } = props
  const [loaded, setLoaded] = useState<{ row: LogbookFlight; flight: Flight | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    runAsync(
      'LogbookView logbookGetFlight',
      window.winglog.logbookGetFlight(listRow.id).then((flight) => {
        if (!cancelled) setLoaded({ row: listRow, flight })
      })
    )
    return () => {
      cancelled = true
    }
  }, [listRow])
  // Keeps showing the previous copy while a re-fetch for the same flight is in flight, rather
  // than flashing "Loading…" after every list reload.
  if (!loaded || loaded.row.id !== listRow.id)
    return <p className="text-sm text-muted-foreground">{t('logbookView.loading')}</p>
  if (!loaded.flight)
    return <p className="text-sm text-muted-foreground">{t('logbookView.flightNotFound')}</p>
  return <FlightDetail {...rest} flight={loaded.flight} />
}

function FlightDetail(props: {
  flight: Flight
  aircraft: Aircraft | undefined
  /** The full fleet — only needed to power AddFlightToFleetDialog's "link to existing"
   *  choice, unlike `aircraft` above (this flight's own linked aircraft, if any). */
  fleetAircraft: Aircraft[]
  weightUnit: WeightUnit
  landingDistanceUnit: LandingDistanceUnit
  mapLanguage?: MapLanguage
  onBack: () => void
  /** True when onBack returns to the Fleet aircraft this flight was opened from, rather
   *  than Logbook's own list — only changes the button label, not the navigation. */
  backToAircraft: boolean
  onDeleted: () => void
  /** Called after AddFlightToFleetDialog successfully links this flight to a fleet aircraft
   *  — the caller reloads its own flight/aircraft lists so the rest of the app (Fleet stats,
   *  the flights table) picks up the change immediately. */
  onAircraftLinked: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { flight, aircraft, weightUnit } = props
  const [trackPoints, setTrackPoints] = useState<TrackPoint[]>([])
  const [confirm, confirmDialog] = useConfirm()
  const [addToFleetOpen, setAddToFleetOpen] = useState(false)

  async function handleDelete(): Promise<void> {
    const ok = await confirm({
      title: t('logbookView.deleteFlightConfirmTitle'),
      description: t('logbookView.deleteFlightConfirmDescription', { count: trackPoints.length }),
      confirmLabel: t('logbookView.deleteFlight'),
      destructive: true
    })
    if (!ok) return
    try {
      await window.winglog.flightDelete(flight.id)
      props.onDeleted()
      toast.success(t('logbookView.flightDeleted'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleViewOfpPdf(): Promise<void> {
    const opened = await window.winglog.logbookOpenOfpPdf(flight.id)
    if (!opened) toast.error(t('logbookView.noOfpPdfForFlight'))
  }

  useEffect(() => {
    runAsync('LogbookView trackPointList', window.winglog.trackPointList(flight.id).then(setTrackPoints))
  }, [flight.id])

  // The persisted selection (Track's live edits at flight completion) if this flight ever
  // had one, else all-null — which reduces to exactly the old OFP-only rendering (Phase 5,
  // docs/plans/navdata-without-navigraph.md). Shows what was actually flown, not just what
  // SimBrief originally planned.
  const waypoints = useLiveWaypoints(flight, selectionFromFlight(flight))
  const route: [number, number][] = useMemo(() => waypoints.map((w) => [w.lon, w.lat]), [waypoints])

  // Fallback for a flight with no OFP-derived route (any CSV-imported historical flight,
  // or one started directly from Track — docs/plans/great-circle-fallback-route.md): fetch
  // a synthesized great-circle line only when the synchronous OFP parse above came back
  // empty, so a flight that does have a real route never pays for this round trip.
  const [fallbackRoute, setFallbackRoute] = useState<[number, number][]>([])
  useEffect(() => {
    if (route.length > 0) return
    let cancelled = false
    runAsync(
      'LogbookView logbookGreatCircleRoute',
      window.winglog.logbookGreatCircleRoute(flight.depIcao, flight.arrIcao).then((points) => {
        if (!cancelled) setFallbackRoute(points ?? [])
      })
    )
    return () => {
      cancelled = true
    }
  }, [route, flight.depIcao, flight.arrIcao])

  const routeIsApproximate = route.length === 0 && fallbackRoute.length > 0
  const displayRoute = route.length > 0 ? route : fallbackRoute
  const displayWaypoints: Waypoint[] = useMemo(() => {
    if (route.length > 0) return waypoints
    if (fallbackRoute.length === 0) return []
    const [depLon, depLat] = fallbackRoute[0]
    const [arrLon, arrLat] = fallbackRoute[fallbackRoute.length - 1]
    return [
      { ident: flight.depIcao, lon: depLon, lat: depLat, altitudeFt: 0, segment: 'enroute' },
      { ident: flight.arrIcao, lon: arrLon, lat: arrLat, altitudeFt: 0, segment: 'enroute' }
    ]
  }, [route, waypoints, fallbackRoute, flight.depIcao, flight.arrIcao])

  // The origin's transition altitude / destination's transition level, for the altitude
  // chart below (docs/plans/logbook-detail-improvements.md, Phase 3) — null for a flight
  // with no OFP, or an older/malformed one; display-altitude.ts falls back to a fixed
  // 18,000 ft both ways in that case.
  const transition = useMemo(() => parseTransitionAltitudes(flight.ofpJson), [flight.ofpJson])

  // Elapsed minutes since the first sample reads better on a chart than raw timestamps.
  // Memoized like route/waypoints above — trackPoints only actually changes once, when
  // the fetch above resolves, so recomputing this on every unrelated re-render was pure
  // waste (previously not memoized at all, unlike its siblings here).
  const profile = useMemo(() => {
    const startMs = trackPoints.length ? new Date(trackPoints[0].tsUtc).getTime() : 0
    return trackPoints.map((p) => {
      // Left unrounded — track points aren't evenly spaced in time (FlightRecorder samples
      // 1-5s depending on phase, then track-simplify.ts's Douglas-Peucker pass keeps more
      // points where the profile bends), so a real `type="number"` time axis needs each
      // point's true elapsed time to plot the chart's actual shape, not just to label it
      // (docs/plans/logbook-detail-improvements.md, item 1).
      const tMin = (new Date(p.tsUtc).getTime() - startMs) / 60000
      // Pressure altitude above the transition, true altitude below it — what the aircraft's
      // own PFD actually showed (Phase 3), not always true/geometric altitude as before.
      const alt = displayAltitude(
        { altitudeM: p.altitudeM, pressureAltitudeM: p.pressureAltitudeM, phase: p.phase },
        transition
      )
      return {
        tMin,
        altFt: Math.round(alt.valueFt),
        altLabel: alt.label,
        iasKt: Math.round(msToKt(p.indicatedAirspeedMs)),
        mach: Math.round(p.machSpeed * 100) / 100
      }
    })
  }, [trackPoints, transition])

  // A flight with no pressure-altitude data at all (recorded before Phase 3 shipped) keeps
  // showing true altitude throughout — labelled as such so the mismatch this whole plan
  // exists to fix isn't re-reported as a new bug against old data.
  const altitudeChartLabel = profile.at(-1)?.altLabel ?? 'Altitude'

  // A long-haul's duration reads better in hours than as a three/four-digit minutes axis
  // — see HOURS_AXIS_THRESHOLD_MIN above. Both charts share the same `tMin` data field
  // regardless: this only changes which tick ladder/label unit is used, not the axis's own
  // domain, so climb/cruise/descent stay proportional to real elapsed time either way.
  const durationMin = profile.at(-1)?.tMin ?? 0
  const useHoursAxis = durationMin > HOURS_AXIS_THRESHOLD_MIN
  const { ticksMin } = useMemo(
    () => computeChartAxisTicks(durationMin, useHoursAxis),
    [durationMin, useHoursAxis]
  )
  const timeAxisUnit = useHoursAxis ? ' hr' : ' min'
  const formatTimeTick = (value: number): string =>
    useHoursAxis ? formatTickLabel(value / 60) : formatTickLabel(value)

  const [speedMode, setSpeedMode] = useState<'ias' | 'mach'>('ias')
  const speedDataKey = speedMode === 'ias' ? 'iasKt' : 'mach'

  // Only meaningful for flights dispatched with a planned fuel figure (SimBrief OFP) —
  // ad-hoc flights created directly from the Track view have no fuelPlannedKg.
  const fuelData =
    flight.fuelPlannedKg != null
      ? [
          { name: t('logbookView.fuelPlanned'), kg: flight.fuelPlannedKg },
          { name: t('logbookView.fuelActual'), kg: flight.fuelBurnKg ?? 0 }
        ]
      : null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={props.onBack} className="w-fit">
          <ArrowLeft />
          {props.backToAircraft ? t('logbookView.backToAircraft') : t('logbookView.backToLogbook')}
        </Button>
        <div className="flex items-center gap-2">
          <KeepCaptureButton flightId={flight.id} />
          <TrackCleanupButton flightId={flight.id} onCleaned={setTrackPoints} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={asyncHandler('LogbookView handleDelete', handleDelete)}
          >
            <Trash2 />
            {t('logbookView.deleteFlight')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <Card className="min-w-72 flex-1">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {flight.flightNumber ? `${flight.flightNumber} — ` : ''}
              {displayIcao(flight.depIcao)} → {displayIcao(flight.arrIcao)}
              {isFreeFlight(flight) && (
                <Badge variant="outline" className="text-xs font-normal">
                  {t('logbookView.freeFlight')}
                </Badge>
              )}
            </CardTitle>
            {flight.ofpJson && (
              <CardAction>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={asyncHandler('LogbookView handleViewOfpPdf', handleViewOfpPdf)}
                >
                  {t('logbookView.viewOfpPdf')}
                </Button>
              </CardAction>
            )}
            {isFreeFlight(flight) && flight.aircraftId == null && (
              <CardAction>
                <Button type="button" variant="outline" size="sm" onClick={() => setAddToFleetOpen(true)}>
                  {t('logbookView.addToFleet')}
                </Button>
              </CardAction>
            )}
          </CardHeader>
          <CardContent>
            <dl className={DETAIL_GRID_CLASS}>
              <DetailField
                label={t('logbookView.fields.aircraft')}
                value={aircraft?.registration ?? flight.simRegistration ?? '—'}
              />
              <DetailField label={t('logbookView.fields.date')} value={formatDate(flight.actualOutUtc)} />
              <DetailField
                label={t('logbookView.fields.blockTime')}
                value={formatMinutes(flight.blockMinutes)}
              />
              <DetailField label={t('logbookView.fields.airTime')} value={formatMinutes(flight.airMinutes)} />
              <DetailField
                label={t('logbookView.fields.fuelBurn')}
                value={formatWeight(flight.fuelBurnKg, weightUnit)}
              />
              <DetailField
                label={t('logbookView.fields.fuelPlanned')}
                value={formatWeight(flight.fuelPlannedKg, weightUnit)}
              />
            </dl>
          </CardContent>
        </Card>
        <LandingCard flightId={flight.id} landingDistanceUnit={props.landingDistanceUnit} />
      </div>

      <div className="h-[min(36vh,360px)] min-h-56">
        <FlightMap
          live={false}
          route={displayRoute}
          waypoints={displayWaypoints}
          trackPoints={trackPoints}
          routeIsApproximate={routeIsApproximate}
          mapLanguage={props.mapLanguage}
        />
      </div>

      {profile.length > 1 && (
        <div className="flex flex-wrap gap-4">
          <Card className="min-w-72 flex-1">
            <CardHeader>
              <CardTitle className="text-sm">
                {altitudeChartLabel === 'True altitude'
                  ? t('logbookView.trueAltitude')
                  : t('logbookView.altitude')}
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
                  <Tooltip
                    content={<ValueTooltip formatValue={(v) => `${Math.round(v).toLocaleString()} ft`} />}
                  />
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
                    onClick={() => setSpeedMode('ias')}
                  >
                    IAS
                  </Button>
                  <Button
                    type="button"
                    variant={speedMode === 'mach' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSpeedMode('mach')}
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
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        {fuelData && (
          <Card className="min-w-72 max-w-96 flex-1">
            <CardHeader>
              <CardTitle className="text-sm">{t('logbookView.fuelPlannedVsActual')}</CardTitle>
            </CardHeader>
            <CardContent className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={fuelData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
                  <XAxis dataKey="name" stroke={CHART_AXIS_COLOR} tick={{ fill: CHART_AXIS_COLOR }} />
                  <YAxis width={60} stroke={CHART_AXIS_COLOR} tick={{ fill: CHART_AXIS_COLOR }} />
                  <Tooltip
                    formatter={(value) => formatWeight(Number(value), weightUnit)}
                    contentStyle={CHART_TOOLTIP_STYLE}
                  />
                  <Bar dataKey="kg" fill={CHART_SERIES_1} name="Fuel" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        <GsxInvoicesCard flightId={flight.id} />
      </div>

      {confirmDialog}
      {isFreeFlight(flight) && flight.aircraftId == null && (
        <AddFlightToFleetDialog
          open={addToFleetOpen}
          onOpenChange={setAddToFleetOpen}
          flight={flight}
          fleetAircraft={props.fleetAircraft}
          onLinked={() => props.onAircraftLinked()}
        />
      )}
    </div>
  )
}
