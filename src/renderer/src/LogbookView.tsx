import { useEffect, useMemo, useState } from 'react'
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
import { ArrowLeft, TriangleAlert, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  Aircraft,
  Flight,
  Landing,
  LandingDistanceUnit,
  LandingRunway,
  LandingScoreCategoryKey,
  LandingScoreResult,
  LandingScoreSummary,
  LogbookStats,
  TrackPoint,
  WeightUnit
} from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { computeChartAxisTicks, formatTickLabel } from './chart-ticks'
import { FlightMap } from './FlightMap'
import { GsxInvoicesCard } from './GsxInvoicesCard'
import { useConfirm } from './hooks/useConfirm'
import { useResetSignal } from './hooks/useResetSignal'
import { useSortable } from './hooks/useSortable'
import { LandingBadge } from './LandingBadge'
import { LandingScoreBadge } from './LandingScoreBadge'
import { LandingScoreBreakdownDialog } from './LandingScoreBreakdownDialog'
import { isCategoryBad } from './landing-score-ui'
import { selectionFromFlight, useLiveWaypoints } from './procedureSelection'
import type { Waypoint } from './route'
import { SortableHead } from './SortableHead'
import { TouchdownDiagram } from './TouchdownDiagram'
import {
  formatCentrelineOffset,
  formatMinutes,
  formatPitchDeg,
  formatRunwayDistance,
  formatWeight,
  mToFt,
  msToFpm,
  msToKt
} from './units'

type View = { kind: 'list' } | { kind: 'detail'; id: number }

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

/** Recharts' default tooltip puts the hovered time on its own header line and the value
 *  below it — but the time is already readable straight off the axis (the vertical cursor
 *  line still shows exactly where the hover is), so the header line just adds noise. This
 *  shows only the formatted value, in the numeric-readout mono style used everywhere else
 *  in the app (docs/plans/logbook-detail-improvements.md, item 2). */
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

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

/** `warn` shows a small warning icon next to the label when this field's own score-
 *  breakdown category came in below LandingScoreBreakdownDialog's bad threshold — a nudge
 *  to open the breakdown rather than repeating the deduction number here too. */
function DetailField(props: {
  label: string
  value: React.ReactNode
  warn?: boolean
  /** Merged onto the value <dd> — e.g. a slightly larger size for the one field (Landing
   *  score) that should stand out from the rest of the list. */
  valueClassName?: string
}): React.JSX.Element {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        {props.label}
        {props.warn && (
          <TriangleAlert
            className="size-3.5 text-destructive"
            aria-label="Below average — see the landing score breakdown"
          />
        )}
      </dt>
      <dd className={cn('text-foreground', props.valueClassName)}>{props.value}</dd>
    </>
  )
}

/** The fuller companion to Fleet's per-aircraft history (docs/decisions.md,
 *  landing-analysis entry) — a Logbook entry is already the place for full flight detail,
 *  so this shows more of the record than Fleet's compact row does. Same conditional-
 *  rendering pattern the fuel chart above already uses: render nothing when there's no
 *  landing to show (the common case for any flight tracked before this feature existed),
 *  not an empty card. */
/** Exported so it's directly testable without mounting FlightDetail's FlightMap, which
 *  LandingCard has no dependency on itself — LogbookView.test.tsx uses this. */
export function LandingCard(props: {
  flightId: number
  landingDistanceUnit: LandingDistanceUnit
}): React.JSX.Element | null {
  const [landing, setLanding] = useState<Landing | null | undefined>(undefined)
  const [runway, setRunway] = useState<LandingRunway | null>(null)
  const [scoreResult, setScoreResult] = useState<LandingScoreResult | null>(null)

  useEffect(() => {
    // Fetched together (docs/plans/logbook-detail-improvements.md) rather than the runway
    // as a second effect keyed off `landing` — that would flash the card at its shorter,
    // no-diagram height first and then grow once the runway arrives.
    Promise.all([
      window.winglog.logbookGetLanding(props.flightId),
      window.winglog.logbookGetLandingRunway(props.flightId),
      window.winglog.logbookGetLandingScore(props.flightId)
    ]).then(([landingResult, runwayResult, scoreResultValue]) => {
      setLanding(landingResult)
      setRunway(runwayResult)
      setScoreResult(scoreResultValue)
    })
  }, [props.flightId])

  // Still loading — render a skeleton at roughly the card's final height rather than
  // nothing, so the layout doesn't jump once the fetch resolves.
  if (landing === undefined) {
    return (
      <Card className="min-w-72 flex-1">
        <CardHeader>
          <CardTitle className="text-sm">Landing</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (!landing) return null

  const unit = props.landingDistanceUnit

  function categoryScore(key: LandingScoreCategoryKey): number | null {
    return scoreResult?.categories.find((c) => c.key === key)?.score ?? null
  }

  return (
    <Card className="min-w-72 flex-1">
      <CardHeader>
        <CardTitle className="text-sm">Landing</CardTitle>
        {scoreResult && (
          // A distinct top-right control (Callum, 2026-09-12) — the old approach put the
          // dialog's only trigger on the score badge itself, buried among a dozen other
          // fields with no visual hint it was clickable.
          <CardAction>
            <LandingScoreBreakdownDialog
              overall={scoreResult.score}
              categories={scoreResult.categories}
              unit={unit}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  Score breakdown
                </Button>
              }
            />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          <DetailField
            label="Landing score"
            value={<LandingScoreBadge score={scoreResult?.score ?? null} />}
            valueClassName="text-base font-semibold"
          />
          <DetailField
            label="Touchdown rate"
            warn={isCategoryBad(categoryScore('verticalSpeed'))}
            value={
              <span className="flex items-center gap-2">
                {Math.round(msToFpm(landing.verticalSpeedMs))} fpm
                {scoreResult && <LandingBadge severity={scoreResult.severity} />}
              </span>
            }
          />
          <DetailField label="G-force" value={landing.gForce.toFixed(2)} warn={isCategoryBad(categoryScore('gForce'))} />
          <DetailField
            label="Pitch"
            value={formatPitchDeg(landing.pitchDeg)}
            warn={isCategoryBad(categoryScore('pitch'))}
          />
          <DetailField
            label="Bank"
            value={`${landing.bankDeg.toFixed(1)}°`}
            warn={isCategoryBad(categoryScore('bank'))}
          />
          <DetailField
            label="Crab"
            value={landing.crabDeg != null ? `${landing.crabDeg.toFixed(1)}°` : '—'}
            warn={isCategoryBad(categoryScore('crab'))}
          />
          <DetailField
            label="Airspeed / Ground speed"
            value={`${Math.round(msToKt(landing.indicatedAirspeedMs))} / ${Math.round(msToKt(landing.groundSpeedMs))} kt`}
          />
          <DetailField
            label="Headwind / Crosswind"
            value={
              landing.headwindMs != null && landing.crosswindMs != null
                ? `${Math.round(msToKt(landing.headwindMs))} / ${Math.round(msToKt(landing.crosswindMs))} kt`
                : '—'
            }
          />
          <DetailField label="Runway" value={landing.runwayIdent ?? '—'} />
          <DetailField
            label="Distance from threshold"
            warn={isCategoryBad(categoryScore('distanceFromAimingPoint'))}
            value={
              landing.distanceFromThresholdM != null
                ? formatRunwayDistance(landing.distanceFromThresholdM, unit)
                : '—'
            }
          />
          <DetailField
            label="Centreline offset"
            warn={isCategoryBad(categoryScore('centrelineOffset'))}
            value={landing.centrelineOffsetM != null ? formatCentrelineOffset(landing.centrelineOffsetM, unit) : '—'}
          />
        </dl>
        {runway && landing.distanceFromThresholdM != null && (
          // No bigger than the field list it sits alongside (Callum, 2026-09-12: the
          // original width-only cap left height unconstrained, so a long runway's tall
          // window could still dwarf the text next to it) — fixed height, width follows
          // from the diagram's own aspect ratio (TouchdownDiagram.tsx). w-36/w-40 gives
          // justify-center real room to work with — without an explicit width the column
          // shrink-wraps the SVG exactly, leaving no slack to centre within, so the runway
          // sat flush against the card's right edge instead of in the middle of its own
          // column (Callum, 2026-09-13).
          <div className="flex h-64 w-36 flex-shrink-0 justify-center self-start sm:w-40">
            <TouchdownDiagram
              runway={runway}
              touchdown={{
                distanceFromThresholdM: landing.distanceFromThresholdM,
                centrelineOffsetM: landing.centrelineOffsetM ?? 0,
                groundSpeedMs: landing.groundSpeedMs
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function FlightDetail(props: {
  flight: Flight
  aircraft: Aircraft | undefined
  weightUnit: WeightUnit
  landingDistanceUnit: LandingDistanceUnit
  onBack: () => void
  /** True when onBack returns to the Fleet aircraft this flight was opened from, rather
   *  than Logbook's own list — only changes the button label, not the navigation. */
  backToAircraft: boolean
  onDeleted: () => void
}): React.JSX.Element {
  const { flight, aircraft, weightUnit } = props
  const [trackPoints, setTrackPoints] = useState<TrackPoint[]>([])
  const [confirm, confirmDialog] = useConfirm()

  async function handleDelete(): Promise<void> {
    const ok = await confirm({
      title: 'Delete this flight?',
      description: `Its track (${trackPoints.length} point${trackPoints.length === 1 ? '' : 's'}), landing report and ground-service invoices go with it. This cannot be undone.`,
      confirmLabel: 'Delete flight',
      destructive: true
    })
    if (!ok) return
    try {
      await window.winglog.flightDelete(flight.id)
      props.onDeleted()
      toast.success('Flight deleted.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleViewOfpPdf(): Promise<void> {
    const opened = await window.winglog.logbookOpenOfpPdf(flight.id)
    if (!opened) toast.error('No OFP PDF available for this flight.')
  }

  useEffect(() => {
    window.winglog.trackPointList(flight.id).then(setTrackPoints)
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
    window.winglog.logbookGreatCircleRoute(flight.depIcao, flight.arrIcao).then((points) => {
      if (!cancelled) setFallbackRoute(points ?? [])
    })
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
      return {
        tMin,
        altFt: Math.round(mToFt(p.altitudeM)),
        iasKt: Math.round(msToKt(p.indicatedAirspeedMs)),
        mach: Math.round(p.machSpeed * 100) / 100
      }
    })
  }, [trackPoints])

  // A long-haul's duration reads better in hours than as a three/four-digit minutes axis
  // — see HOURS_AXIS_THRESHOLD_MIN above. Both charts share the same `tMin` data field
  // regardless: this only changes which tick ladder/label unit is used, not the axis's own
  // domain, so climb/cruise/descent stay proportional to real elapsed time either way.
  const durationMin = profile.at(-1)?.tMin ?? 0
  const useHoursAxis = durationMin > HOURS_AXIS_THRESHOLD_MIN
  const { ticksMin } = useMemo(() => computeChartAxisTicks(durationMin, useHoursAxis), [durationMin, useHoursAxis])
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
          { name: 'Planned', kg: flight.fuelPlannedKg },
          { name: 'Actual', kg: flight.fuelBurnKg ?? 0 }
        ]
      : null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={props.onBack} className="w-fit">
          <ArrowLeft />
          {props.backToAircraft ? 'Back to aircraft' : 'Back to logbook'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={handleDelete}>
          <Trash2 />
          Delete flight
        </Button>
      </div>

      <div className="flex flex-wrap gap-4">
        <Card className="min-w-72 flex-1">
          <CardHeader>
            <CardTitle>
              {flight.flightNumber ?? `Flight #${flight.id}`} — {flight.depIcao} → {flight.arrIcao}
            </CardTitle>
            {flight.ofpJson && (
              <CardAction>
                <Button type="button" variant="outline" size="sm" onClick={handleViewOfpPdf}>
                  View OFP PDF
                </Button>
              </CardAction>
            )}
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
              <DetailField label="Aircraft" value={aircraft?.registration ?? '—'} />
              <DetailField label="Date" value={formatDate(flight.actualOutUtc)} />
              <DetailField label="Block time" value={formatMinutes(flight.blockMinutes)} />
              <DetailField label="Air time" value={formatMinutes(flight.airMinutes)} />
              <DetailField label="Fuel burn" value={formatWeight(flight.fuelBurnKg, weightUnit)} />
              <DetailField label="Fuel planned" value={formatWeight(flight.fuelPlannedKg, weightUnit)} />
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
        />
      </div>

      {profile.length > 1 && (
        <div className="flex flex-wrap gap-4">
          <Card className="min-w-72 flex-1">
            <CardHeader>
              <CardTitle className="text-sm">Altitude</CardTitle>
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
          <Card className="min-w-72 flex-1">
            <CardHeader>
              <CardTitle className="text-sm">Speed ({speedMode === 'ias' ? 'IAS' : 'Mach'})</CardTitle>
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
                    tickFormatter={speedMode === 'mach' ? (v: number) => v.toFixed(2) : (v: number) => v.toLocaleString()}
                  />
                  <Tooltip
                    content={
                      <ValueTooltip
                        formatValue={(v) => (speedMode === 'ias' ? `${Math.round(v).toLocaleString()} kt` : `M${v.toFixed(2)}`)}
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
              <CardTitle className="text-sm">Fuel planned vs actual</CardTitle>
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
    </div>
  )
}

type SortKey = 'date' | 'flight' | 'route' | 'aircraft' | 'block' | 'score' | 'fuel'

// 'score' is last (Callum, 2026-09-12) — it's the column most worth glancing down as a
// column, so it reads best at the row's end rather than interrupting block/fuel.
const SORT_COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'flight', label: 'Flight' },
  { key: 'route', label: 'Route' },
  { key: 'aircraft', label: 'Aircraft' },
  { key: 'block', label: 'Block' },
  { key: 'fuel', label: 'Fuel burn' },
  { key: 'score', label: 'Landing Score', className: 'text-center' }
]

function compareFlights(
  a: Flight,
  b: Flight,
  key: SortKey,
  registrationFor: (aircraftId: number) => string,
  scoreFor: (flightId: number) => number | null
): number {
  switch (key) {
    case 'date':
      return (a.actualOutUtc ?? '').localeCompare(b.actualOutUtc ?? '')
    case 'flight':
      return (a.flightNumber ?? '').localeCompare(b.flightNumber ?? '')
    case 'route':
      return `${a.depIcao}${a.arrIcao}`.localeCompare(`${b.depIcao}${b.arrIcao}`)
    case 'aircraft':
      return registrationFor(a.aircraftId).localeCompare(registrationFor(b.aircraftId))
    case 'block':
      return (a.blockMinutes ?? 0) - (b.blockMinutes ?? 0)
    // A missing score (no landing row — a CSV import, or a flight tracked before landing
    // capture shipped) sorts alongside a genuine 0, same convention 'block'/'fuel' above
    // already use for their own nullable fields.
    case 'score':
      return (scoreFor(a.id) ?? 0) - (scoreFor(b.id) ?? 0)
    case 'fuel':
      return (a.fuelBurnKg ?? 0) - (b.fuelBurnKg ?? 0)
  }
}

function LogbookRowsSkeleton(): React.JSX.Element {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <TableRow key={i}>
          {[0, 1, 2, 3, 4, 5, 6].map((col) => (
            <TableCell key={col}>
              <Skeleton className="h-4 w-16" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

export function LogbookView(props: {
  weightUnit: WeightUnit
  landingDistanceUnit: LandingDistanceUnit
  /** Set when another view (e.g. Fleet's per-aircraft flight list) navigated here to open
   *  a specific flight directly, rather than the user picking one from the list. */
  initialFlightId?: number | null
  /** The Fleet aircraft this flight was opened from, if any — used to send "Back" there
   *  instead of Logbook's own list. Only ever meaningful together with initialFlightId. */
  initialFlightOriginAircraftId?: number | null
  /** Called once initialFlightId has been consumed, so navigating here again from a
   *  different tab (this component remounts each time, per App.tsx's conditional render)
   *  doesn't keep reopening the same flight. */
  onInitialFlightConsumed?: () => void
  /** Navigates back to a specific Fleet aircraft — wired to "Back" when the current
   *  detail view is the flight that was opened from that aircraft's flights list. */
  onBackToAircraft?: (aircraftId: number) => void
  /** Bumped by App.tsx when the Logbook tab is clicked while already active — returns to
   *  the flight list without touching sort/filters (docs/plans/navigation-tab-behaviour.md).
   *  Distinct from onInitialFlightConsumed above: that's a remount-time concern (arriving
   *  from elsewhere), this is a same-mount concern (already here). See useResetSignal. */
  resetSignal?: number
}): React.JSX.Element {
  const [flights, setFlights] = useState<Flight[]>([])
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [stats, setStats] = useState<LogbookStats | null>(null)
  const [scores, setScores] = useState<LandingScoreSummary[]>([])
  const [view, setView] = useState<View>(
    props.initialFlightId != null ? { kind: 'detail', id: props.initialFlightId } : { kind: 'list' }
  )
  const [loading, setLoading] = useState(true)
  useResetSignal(props.resetSignal, () => setView({ kind: 'list' }))
  // Captured once at mount, independent of the props themselves — App.tsx clears
  // pendingLogbookFlight (nulling these props) right after consuming them, but "was this
  // detail view reached via a Fleet cross-navigation" needs to stay true for as long as
  // the user is looking at that same flight, not just for the first render.
  const [initialFlightId] = useState(props.initialFlightId ?? null)
  const [initialFlightOriginAircraftId] = useState(props.initialFlightOriginAircraftId ?? null)

  useEffect(() => {
    if (props.initialFlightId != null) props.onInitialFlightConsumed?.()
    // Only ever meant to run once, against the initial prop value — see the state
    // initializer above, which already captured it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function reload(): Promise<void> {
    return Promise.all([
      window.winglog.logbookListCompletedFlights(),
      window.winglog.aircraftList(),
      window.winglog.logbookGetStats(),
      window.winglog.logbookListFlightScores()
    ]).then(([flightList, aircraftList, logbookStats, flightScores]) => {
      setFlights(flightList)
      setAircraft(aircraftList)
      setStats(logbookStats)
      setScores(flightScores)
    })
  }

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [])

  function registrationFor(aircraftId: number): string {
    return aircraft.find((a) => a.id === aircraftId)?.registration ?? `#${aircraftId}`
  }

  function scoreFor(flightId: number): number | null {
    return scores.find((s) => s.flightId === flightId)?.score ?? null
  }

  const comparators = Object.fromEntries(
    SORT_COLUMNS.map((col) => [
      col.key,
      (a: Flight, b: Flight) => compareFlights(a, b, col.key, registrationFor, scoreFor)
    ])
  ) as Record<SortKey, (a: Flight, b: Flight) => number>
  const {
    sortKey,
    sortDir,
    sortedRows: sortedFlights,
    handleSort
  } = useSortable<Flight, SortKey>(flights, comparators, 'date', 'desc')

  if (view.kind === 'detail') {
    const flight = flights.find((f) => f.id === view.id)
    if (!flight) return <p className="text-sm text-muted-foreground">Flight not found.</p>
    // Only the exact flight that was opened from Fleet sends "Back" there — navigating
    // to a different flight from Logbook's own list (even after arriving via Fleet)
    // falls back to the ordinary "back to list" behaviour.
    const cameFromFleet = flight.id === initialFlightId && initialFlightOriginAircraftId != null
    return (
      <FlightDetail
        flight={flight}
        aircraft={aircraft.find((a) => a.id === flight.aircraftId)}
        weightUnit={props.weightUnit}
        landingDistanceUnit={props.landingDistanceUnit}
        backToAircraft={cameFromFleet}
        onBack={
          cameFromFleet
            ? () => props.onBackToAircraft?.(initialFlightOriginAircraftId!)
            : () => setView({ kind: 'list' })
        }
        onDeleted={() => {
          setView({ kind: 'list' })
          reload()
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold text-foreground">Logbook</h1>

      {loading ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Flight</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Aircraft</TableHead>
              <TableHead>Block</TableHead>
              <TableHead>Fuel burn</TableHead>
              <TableHead className="text-center">Landing Score</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <LogbookRowsSkeleton />
          </TableBody>
        </Table>
      ) : flights.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No completed flights yet — track one, or import a CSV logbook from Settings → Data.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-8">
            <div>
              <p className="text-xs tracking-wide text-muted-foreground uppercase">Total flights</p>
              <p className="text-xl font-semibold text-foreground">{stats?.totalFlights ?? flights.length}</p>
            </div>
            <div>
              <p className="text-xs tracking-wide text-muted-foreground uppercase">Total flight hours</p>
              <p className="text-xl font-semibold text-foreground">
                {formatMinutes(stats?.totalBlockMinutes ?? null)}
              </p>
            </div>
            <div>
              <p className="text-xs tracking-wide text-muted-foreground uppercase">Total miles flown</p>
              <p className="text-xl font-semibold text-foreground">
                {stats ? `${Math.round(stats.totalNm).toLocaleString()} nm` : '—'}
              </p>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                {SORT_COLUMNS.map((col) => (
                  <SortableHead
                    key={col.key}
                    sortKey={col.key}
                    label={col.label}
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    className={col.className}
                  />
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedFlights.map((f) => (
                <TableRow
                  key={f.id}
                  onClick={() => setView({ kind: 'detail', id: f.id })}
                  className="cursor-pointer"
                >
                  <TableCell>{formatDate(f.actualOutUtc)}</TableCell>
                  <TableCell>{f.flightNumber ?? '—'}</TableCell>
                  <TableCell>
                    {f.depIcao} → {f.arrIcao}
                  </TableCell>
                  <TableCell>{registrationFor(f.aircraftId)}</TableCell>
                  <TableCell>{formatMinutes(f.blockMinutes)}</TableCell>
                  <TableCell>{formatWeight(f.fuelBurnKg, props.weightUnit)}</TableCell>
                  <TableCell className="text-center">
                    <LandingScoreBadge score={scoreFor(f.id)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  )
}
