import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
  LandingDistanceUnit,
  MapLanguage,
  LandingListRow,
  LandingScoreCategoryKey,
  LandingScoreSummary,
  LandingWithDetails,
  LogbookStats,
  TrackPoint,
  WeightUnit
} from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FolderTabs, FolderTabsContent, FolderTabsList, FolderTabsTrigger } from './components/FolderTabs'
import { cn } from '@/lib/utils'
import { AddFlightToFleetDialog } from './AddFlightToFleetDialog'
import { computeChartAxisTicks, formatTickLabel } from './chart-ticks'
import { displayAltitude } from './display-altitude'
import { displayIcao } from './display-icao'
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
import { parseTransitionAltitudes, type Waypoint } from './route'
import { SortableHead } from './SortableHead'
import { TouchdownDiagram } from './TouchdownDiagram'
import { TrackCleanupButton } from './TrackCleanupButton'
import {
  formatCentrelineOffset,
  formatMinutes,
  formatPitchDeg,
  formatRunwayDistance,
  formatWeight,
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

/**
 * A flight actually tracked live through free-flight-tracking.md, not a dispatched one and
 * not a CSV import — neither of those two other origins is directly recorded on the row, so
 * this infers it from the two things that are: no OFP (`ofpJson` null, same as a CSV import)
 * *and* a real liftoff was recorded (`actualOffUtc` set, which a CSV import never has —
 * logbook-import.ts's createHistoricalFlight only ever supplies block-time timestamps, not
 * off/on). A free flight that never left the ground before "Finish & save" won't show the
 * badge — an acceptable miss for what's purely a display label, not something anything else
 * depends on.
 */
function isFreeFlight(flight: Flight): boolean {
  return !flight.ofpJson && flight.actualOffUtc != null
}

/** `warn` shows a small warning icon next to the label when this field's own score-
 *  breakdown category came in below LandingScoreBreakdownDialog's bad threshold — a nudge
 *  to open the breakdown rather than repeating the deduction number here too. */
/** Two label/value columns whose tracks may shrink below their content's width
 *  (`minmax(0, 1fr)`, not the bare `1fr` of `grid-cols-2`, which can't) - otherwise a long
 *  label or mono-font value overflows into its neighbour when the window narrows (beta
 *  feedback 2026-09-18). Paired with DetailField's `min-w-0 break-words`. */
export const DETAIL_GRID_CLASS = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm'

function DetailField(props: {
  label: string
  value: React.ReactNode
  warn?: boolean
  /** Merged onto the value <dd> — e.g. a slightly larger size for the one field (Landing
   *  score) that should stand out from the rest of the list. */
  valueClassName?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <dt className="flex min-w-0 items-center gap-1.5 break-words text-muted-foreground">
        {props.label}
        {props.warn && (
          <TriangleAlert className="size-3.5 text-destructive" aria-label={t('logbookView.belowAverage')} />
        )}
      </dt>
      <dd className={cn('min-w-0 break-words text-foreground', props.valueClassName)}>{props.value}</dd>
    </>
  )
}

/** The fuller companion to Fleet's per-aircraft history (docs/decisions.md,
 *  landing-analysis entry) — a Logbook entry is already the place for full flight detail,
 *  so this shows more of the record than Fleet's compact row does. Same conditional-
 *  rendering pattern the fuel chart above already uses: render nothing when there's no
 *  landing to show (the common case for any flight tracked before this feature existed),
 *  not an empty card. */
// Above this many landings, per-landing tabs across the card header would shrink to
// unreadable — a Select takes over instead (Callum's design, 2026-09-16). 4 is the plan
// doc's own recommendation from the card's layout, not a measured breakpoint — worth a
// look at the real card at the narrowest supported width if it ever looks cramped.
const LANDING_TAB_THRESHOLD = 4

/** Labels for the tabs/select switcher: the airfield and which attempt it was *at that
 *  airfield* ("VHHX 1", "VHHH 1", then "VHHH 2") — not a runway and a clock time, which read as
 *  data rather than as "which landing is this" (Callum, 2026-09-19). A touchdown with no
 *  resolved airfield falls back to its position in the whole sequence ("Landing 2"). The
 *  runway is still shown inside the card itself. */
// Not yet translated — a pure exported function with its own unit tests asserting exact
// English output, same deliberate gap as flight-label.ts's "this flight"/"flight from X"
// (docs/plans/v1-2.md Part 3). displayIcao's own "Unknown" fallback (for ZZZZ) is the same
// kind of gap, already shipped untranslated across Fleet/Dispatch/Track.
export function landingLabels(landings: { icao: string | null }[]): string[] {
  const attempts = new Map<string, number>()
  return landings.map((l, index) => {
    if (!l.icao) return `Landing ${index + 1}`
    const attempt = (attempts.get(l.icao) ?? 0) + 1
    attempts.set(l.icao, attempt)
    return `${displayIcao(l.icao)} ${attempt}`
  })
}

/** Exported so it's directly testable without mounting FlightDetail's FlightMap, which
 *  LandingCard has no dependency on itself — LogbookView.test.tsx uses this. */
export function LandingCard(props: {
  flightId: number
  landingDistanceUnit: LandingDistanceUnit
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [landings, setLandings] = useState<LandingWithDetails[] | undefined>(undefined)
  // Index into `landings`, not a landing id — simpler to default ("the last one") and to
  // drive both the tabs and the select from the same piece of state. Reset per flight by
  // the fetch effect below, not derived inline, so switching flights doesn't strand the
  // previous flight's selected index against the new one's (possibly shorter) list.
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    window.winglog.logbookListLandings(props.flightId).then((result) => {
      setLandings(result)
      // Defaults to the final touchdown — the one that ended the flight — matching
      // Logbook's own flights-list score column.
      setSelectedIndex(Math.max(0, result.length - 1))
    })
  }, [props.flightId])

  // Still loading — render a skeleton at roughly the card's final height rather than
  // nothing, so the layout doesn't jump once the fetch resolves.
  if (landings === undefined) {
    return (
      <Card className="min-w-72 flex-1">
        <CardHeader>
          <CardTitle className="text-sm">{t('logbookView.landingCard.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (landings.length === 0) return null

  const labels = landingLabels(landings)
  const landing = landings[Math.min(selectedIndex, landings.length - 1)]
  const runway = landing.runway
  const scoreResult = landing.score
  const unit = props.landingDistanceUnit

  function categoryScore(key: LandingScoreCategoryKey): number | null {
    return scoreResult?.categories.find((c) => c.key === key)?.score ?? null
  }

  return (
    // `@container` + `@lg:` rather than the viewport's `sm:` - the card's width depends on
    // the layout around it (it wraps beside other cards), not just the window.
    <Card className="@container min-w-72 flex-1">
      <CardHeader>
        <CardTitle className="text-sm">{t('logbookView.landingCard.title')}</CardTitle>
        {landings.length > 1 && (
          <CardAction>
            {landings.length <= LANDING_TAB_THRESHOLD ? (
              <Tabs value={String(selectedIndex)} onValueChange={(v) => setSelectedIndex(Number(v))}>
                <TabsList aria-label={t('logbookView.landingCard.selectLanding')}>
                  {landings.map((l, i) => (
                    <TabsTrigger key={l.id} value={String(i)}>
                      {labels[i]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            ) : (
              <Select value={String(selectedIndex)} onValueChange={(v) => setSelectedIndex(Number(v))}>
                <SelectTrigger className="w-40" size="sm" aria-label={t('logbookView.landingCard.selectLanding')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {landings.map((l, i) => (
                    <SelectItem key={l.id} value={String(i)}>
                      {labels[i]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 @lg:flex-row @lg:items-start">
        <dl className={cn(DETAIL_GRID_CLASS, 'min-w-0 flex-1')}>
          <DetailField
            label={t('logbookView.landingCard.landingScore')}
            value={<LandingScoreBadge score={scoreResult?.score ?? null} />}
            valueClassName="text-base font-semibold"
          />
          <DetailField
            label={t('logbookView.landingCard.touchdownRate')}
            warn={isCategoryBad(categoryScore('verticalSpeed'))}
            value={
              <span className="flex items-center gap-2">
                {Math.round(msToFpm(landing.verticalSpeedMs))} fpm
                {scoreResult && <LandingBadge severity={scoreResult.severity} />}
              </span>
            }
          />
          <DetailField
            label={t('logbookView.landingCard.gForce')}
            value={landing.gForce.toFixed(2)}
            warn={isCategoryBad(categoryScore('gForce'))}
          />
          <DetailField
            label={t('logbookView.landingCard.pitch')}
            value={formatPitchDeg(landing.pitchDeg)}
            warn={isCategoryBad(categoryScore('pitch'))}
          />
          <DetailField
            label={t('logbookView.landingCard.bank')}
            value={`${landing.bankDeg.toFixed(1)}°`}
            warn={isCategoryBad(categoryScore('bank'))}
          />
          <DetailField
            label={t('logbookView.landingCard.crab')}
            value={landing.crabDeg != null ? `${landing.crabDeg.toFixed(1)}°` : '—'}
            warn={isCategoryBad(categoryScore('crab'))}
          />
          <DetailField
            label={t('logbookView.landingCard.airspeedGroundSpeed')}
            value={`${Math.round(msToKt(landing.indicatedAirspeedMs))} / ${Math.round(msToKt(landing.groundSpeedMs))} kt`}
          />
          <DetailField
            label={t('logbookView.landingCard.headwindCrosswind')}
            value={
              landing.headwindMs != null && landing.crosswindMs != null
                ? `${Math.round(msToKt(landing.headwindMs))} / ${Math.round(msToKt(landing.crosswindMs))} kt`
                : '—'
            }
          />
          <DetailField label={t('logbookView.landingCard.runway')} value={landing.runwayIdent ?? '—'} />
          <DetailField
            label={t('logbookView.landingCard.distanceFromThreshold')}
            warn={isCategoryBad(categoryScore('distanceFromAimingPoint'))}
            value={
              landing.distanceFromThresholdM != null
                ? formatRunwayDistance(landing.distanceFromThresholdM, unit)
                : '—'
            }
          />
          <DetailField
            label={t('logbookView.landingCard.centrelineOffset')}
            warn={isCategoryBad(categoryScore('centrelineOffset'))}
            value={
              landing.centrelineOffsetM != null
                ? formatCentrelineOffset(landing.centrelineOffsetM, unit)
                : '—'
            }
          />
        </dl>
        {scoreResult && (
          // The breakdown trigger lives in this same right-hand column, centred above the
          // diagram (Callum, 2026-09-13), rather than in the card header — a header
          // button's own right-alignment doesn't line up with this narrower column's
          // centre, and CardHeader/CardContent are separate layout contexts with no shared
          // width to align against. Rendered whenever a score exists, independent of the
          // diagram below it, since most categories still score without a runway match.
          <div className="flex w-full flex-shrink-0 flex-col items-center gap-2 self-start @lg:w-40">
            <LandingScoreBreakdownDialog
              overall={scoreResult.score}
              categories={scoreResult.categories}
              unit={unit}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  {t('logbookView.landingCard.scoreBreakdown')}
                </Button>
              }
            />
            {runway && landing.distanceFromThresholdM != null && (
              // No bigger than the field list it sits alongside (Callum, 2026-09-12: the
              // original width-only cap left height unconstrained, so a long runway's tall
              // window could still dwarf the text next to it) — fixed height, width
              // follows from the diagram's own aspect ratio (TouchdownDiagram.tsx).
              <div className="flex h-56 w-full justify-center">
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
          </div>
        )}
      </CardContent>
    </Card>
  )
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
          <TrackCleanupButton flightId={flight.id} onCleaned={setTrackPoints} />
          <Button type="button" variant="ghost" size="sm" onClick={handleDelete}>
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
                <Button type="button" variant="outline" size="sm" onClick={handleViewOfpPdf}>
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
              <DetailField label={t('logbookView.fields.blockTime')} value={formatMinutes(flight.blockMinutes)} />
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

type SortKey = 'date' | 'flight' | 'route' | 'aircraft' | 'block' | 'score' | 'fuel'

// 'score' is last (Callum, 2026-09-12) — it's the column most worth glancing down as a
// column, so it reads best at the row's end rather than interrupting block/fuel.
const SORT_KEYS: SortKey[] = ['date', 'flight', 'route', 'aircraft', 'block', 'fuel', 'score']

function sortColumns(t: TFunction): { key: SortKey; label: string; className?: string }[] {
  return [
    { key: 'date', label: t('logbookView.sortColumns.date') },
    { key: 'flight', label: t('logbookView.sortColumns.flight') },
    { key: 'route', label: t('logbookView.sortColumns.route') },
    { key: 'aircraft', label: t('logbookView.sortColumns.aircraft') },
    { key: 'block', label: t('logbookView.sortColumns.block') },
    { key: 'fuel', label: t('logbookView.sortColumns.fuelBurn') },
    { key: 'score', label: t('logbookView.sortColumns.landingScore'), className: 'text-center' }
  ]
}

function compareFlights(
  a: Flight,
  b: Flight,
  key: SortKey,
  registrationFor: (flight: Flight) => string,
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
      return registrationFor(a).localeCompare(registrationFor(b))
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

type LandingSortKey = 'date' | 'aircraft' | 'airport' | 'flight' | 'rate' | 'gforce' | 'score'

// Same column positions as the Flights table (Date, Flight, Route~Airport, Aircraft, ..., Score)
// so switching between the two tabs doesn't shuffle the headers around under the cursor.
const LANDING_SORT_KEYS: LandingSortKey[] = ['date', 'flight', 'airport', 'aircraft', 'rate', 'gforce', 'score']

function landingSortColumns(t: TFunction): { key: LandingSortKey; label: string; className?: string }[] {
  return [
    { key: 'date', label: t('logbookView.landingSortColumns.date') },
    { key: 'flight', label: t('logbookView.landingSortColumns.flight') },
    { key: 'airport', label: t('logbookView.landingSortColumns.airport') },
    { key: 'aircraft', label: t('logbookView.landingSortColumns.aircraft') },
    { key: 'rate', label: t('logbookView.landingSortColumns.touchdownRate') },
    { key: 'gforce', label: t('logbookView.landingSortColumns.gForce') },
    { key: 'score', label: t('logbookView.landingSortColumns.score'), className: 'text-center' }
  ]
}

function compareLandingRows(a: LandingListRow, b: LandingListRow, key: LandingSortKey): number {
  switch (key) {
    case 'date':
      return a.touchdownTsUtc.localeCompare(b.touchdownTsUtc)
    case 'aircraft':
      return a.aircraftRegistration.localeCompare(b.aircraftRegistration)
    case 'airport':
      return `${a.icao ?? ''}${a.runwayIdent ?? ''}`.localeCompare(`${b.icao ?? ''}${b.runwayIdent ?? ''}`)
    case 'flight':
      return (a.flightNumber ?? '').localeCompare(b.flightNumber ?? '')
    case 'rate':
      return a.verticalSpeedMs - b.verticalSpeedMs
    case 'gforce':
      return a.gForce - b.gForce
    // A missing score sorts alongside a genuine 0, same convention the flights table's own
    // score column already uses.
    case 'score':
      return (a.score ?? 0) - (b.score ?? 0)
  }
}

/** The Logbook Landings sub-tab (flightdeck-backend's docs/plans/multiple-landings.md
 *  Phase 3) — every touchdown across the whole fleet, one row per landing rather than one
 *  row per flight. Exported for direct testing, same reasoning as LandingCard above. */
export function LandingsTable(props: {
  onOpenFlight: (flightId: number) => void
  /** Already-fetched rows (LogbookView loads them with the flights, so switching to this tab
   *  is instant with no skeleton). Omit to have the table fetch its own. */
  landings?: LandingListRow[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const [ownLandings, setOwnLandings] = useState<LandingListRow[] | undefined>(undefined)

  useEffect(() => {
    if (props.landings !== undefined) return
    window.winglog.logbookListAllLandings().then(setOwnLandings)
  }, [props.landings])
  const landings = props.landings ?? ownLandings

  const comparators = Object.fromEntries(
    LANDING_SORT_KEYS.map((key) => [key, (a: LandingListRow, b: LandingListRow) => compareLandingRows(a, b, key)])
  ) as Record<LandingSortKey, (a: LandingListRow, b: LandingListRow) => number>
  const {
    sortKey,
    sortDir,
    sortedRows: sortedLandings,
    handleSort
  } = useSortable<LandingListRow, LandingSortKey>(landings ?? [], comparators, 'date', 'desc')

  if (landings === undefined) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            {landingSortColumns(t).map((col) => (
              <TableHead key={col.key} className={col.className}>
                {col.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <LogbookRowsSkeleton />
        </TableBody>
      </Table>
    )
  }

  if (landings.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('logbookView.landingsEmpty')}</p>
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {landingSortColumns(t).map((col) => (
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
        {sortedLandings.map((l) => (
          <TableRow key={l.id} onClick={() => props.onOpenFlight(l.flightId)} className="cursor-pointer">
            <TableCell>{formatDate(l.touchdownTsUtc)}</TableCell>
            <TableCell>{l.flightNumber ?? '—'}</TableCell>
            <TableCell>
              {l.icao ? displayIcao(l.icao) : '—'}
              {l.runwayIdent ? ` / ${l.runwayIdent}` : ''}
            </TableCell>
            <TableCell>{l.aircraftRegistration}</TableCell>
            <TableCell>{Math.round(msToFpm(l.verticalSpeedMs))} fpm</TableCell>
            <TableCell>{l.gForce.toFixed(2)}</TableCell>
            <TableCell className="text-center">
              <LandingScoreBadge score={l.score} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function LogbookView(props: {
  weightUnit: WeightUnit
  landingDistanceUnit: LandingDistanceUnit
  mapLanguage?: MapLanguage
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
  const { t } = useTranslation()
  const [flights, setFlights] = useState<Flight[]>([])
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [stats, setStats] = useState<LogbookStats | null>(null)
  const [scores, setScores] = useState<LandingScoreSummary[]>([])
  const [allLandings, setAllLandings] = useState<LandingListRow[] | undefined>(undefined)
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
      window.winglog.logbookListFlightScores(),
      window.winglog.logbookListAllLandings()
    ]).then(([flightList, aircraftList, logbookStats, flightScores, landingRows]) => {
      setFlights(flightList)
      setAircraft(aircraftList)
      setStats(logbookStats)
      setScores(flightScores)
      setAllLandings(landingRows)
    })
  }

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [])

  /** A free flight tracked with no fleet aircraft has no aircraftId to look up — falls back
   *  to the sim-reported registration recorded directly on the flight row instead. */
  function registrationFor(flight: Flight): string {
    if (flight.aircraftId != null) {
      return aircraft.find((a) => a.id === flight.aircraftId)?.registration ?? `#${flight.aircraftId}`
    }
    return flight.simRegistration ?? '—'
  }

  function scoreFor(flightId: number): number | null {
    return scores.find((s) => s.flightId === flightId)?.score ?? null
  }

  /** Landing count for the flights list's "×3" badge (flightdeck-backend's docs/plans/
   *  multiple-landings.md) — 0 for a flight with no landing row, same cases scoreFor
   *  returns null for. */
  function landingCountFor(flightId: number): number {
    return scores.find((s) => s.flightId === flightId)?.landingCount ?? 0
  }

  const comparators = Object.fromEntries(
    SORT_KEYS.map((key) => [key, (a: Flight, b: Flight) => compareFlights(a, b, key, registrationFor, scoreFor)])
  ) as Record<SortKey, (a: Flight, b: Flight) => number>
  const {
    sortKey,
    sortDir,
    sortedRows: sortedFlights,
    handleSort
  } = useSortable<Flight, SortKey>(flights, comparators, 'date', 'desc')

  if (view.kind === 'detail') {
    const flight = flights.find((f) => f.id === view.id)
    if (!flight) return <p className="text-sm text-muted-foreground">{t('logbookView.flightNotFound')}</p>
    // Only the exact flight that was opened from Fleet sends "Back" there — navigating
    // to a different flight from Logbook's own list (even after arriving via Fleet)
    // falls back to the ordinary "back to list" behaviour.
    const cameFromFleet = flight.id === initialFlightId && initialFlightOriginAircraftId != null
    return (
      <FlightDetail
        flight={flight}
        aircraft={aircraft.find((a) => a.id === flight.aircraftId)}
        fleetAircraft={aircraft}
        weightUnit={props.weightUnit}
        landingDistanceUnit={props.landingDistanceUnit}
        mapLanguage={props.mapLanguage}
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
        onAircraftLinked={() => reload()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold text-foreground">{t('logbookView.title')}</h1>

      {!loading && flights.length > 0 && (
        <div className="flex flex-wrap gap-8">
          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">
              {t('logbookView.stats.totalFlights')}
            </p>
            <p className="text-xl font-semibold text-foreground">{stats?.totalFlights ?? flights.length}</p>
          </div>
          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">
              {t('logbookView.stats.totalFlightHours')}
            </p>
            <p className="text-xl font-semibold text-foreground">
              {formatMinutes(stats?.totalBlockMinutes ?? null)}
            </p>
          </div>
          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">
              {t('logbookView.stats.totalMilesFlown')}
            </p>
            <p className="text-xl font-semibold text-foreground">
              {stats ? `${Math.round(stats.totalNm).toLocaleString()} nm` : '—'}
            </p>
          </div>
        </div>
      )}

      <FolderTabs defaultValue="flights" className="gap-0">
        <FolderTabsList>
          <FolderTabsTrigger value="flights">{t('logbookView.tabs.flights')}</FolderTabsTrigger>
          <FolderTabsTrigger value="landings">{t('logbookView.tabs.landings')}</FolderTabsTrigger>
        </FolderTabsList>

        <FolderTabsContent value="flights" className="pt-4">
          {loading ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {sortColumns(t).map((col) => (
                    <TableHead key={col.key} className={col.className}>
                      {col.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                <LogbookRowsSkeleton />
              </TableBody>
            </Table>
          ) : flights.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('logbookView.noCompletedFlights')}</p>
          ) : (
            <div className="flex flex-col gap-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    {sortColumns(t).map((col) => (
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
                  {sortedFlights.map((f) => {
                    const landingCount = landingCountFor(f.id)
                    return (
                      <TableRow
                        key={f.id}
                        onClick={() => setView({ kind: 'detail', id: f.id })}
                        className="cursor-pointer"
                      >
                        <TableCell>{formatDate(f.actualOutUtc)}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5">
                            {f.flightNumber ?? '—'}
                            {isFreeFlight(f) && (
                              <Badge variant="outline" className="text-xs font-normal">
                                {t('logbookView.freeFlight')}
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          {displayIcao(f.depIcao)} → {displayIcao(f.arrIcao)}
                        </TableCell>
                        <TableCell>{registrationFor(f)}</TableCell>
                        <TableCell>{formatMinutes(f.blockMinutes)}</TableCell>
                        <TableCell>{formatWeight(f.fuelBurnKg, props.weightUnit)}</TableCell>
                        <TableCell className="text-center">
                          <span className="inline-flex items-center gap-1.5">
                            <LandingScoreBadge score={scoreFor(f.id)} />
                            {landingCount > 1 && (
                              <Badge variant="outline" className="text-xs">
                                ×{landingCount}
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </FolderTabsContent>

        <FolderTabsContent value="landings" className="pt-4">
          <LandingsTable landings={allLandings} onOpenFlight={(id) => setView({ kind: 'detail', id })} />
        </FolderTabsContent>
      </FolderTabs>
    </div>
  )
}
