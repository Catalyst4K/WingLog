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
import { ArrowLeft, ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Aircraft, Flight, Landing, LogbookStats, TrackPoint, WeightUnit } from '@shared/ipc'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { FlightMap } from './FlightMap'
import { GsxInvoicesCard } from './GsxInvoicesCard'
import { LandingBadge } from './LandingBadge'
import { classifyLanding } from './landing-severity'
import { parseRouteFromOfpJson, parseWaypointsFromOfpJson } from './route'
import { formatWeight, mToFt, msToFpm, msToKt } from './units'
import { useLandingThresholds } from './useLandingThresholds'

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

function formatMinutes(min: number | null): string {
  if (min == null) return '—'
  const hours = Math.floor(min / 60)
  const minutes = Math.round(min % 60)
  return `${hours}h ${minutes}m`
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

function DetailField(props: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="text-foreground">{props.value}</dd>
    </>
  )
}

/** The fuller companion to Fleet's per-aircraft history (docs/decisions.md,
 *  landing-analysis entry) — a Logbook entry is already the place for full flight detail,
 *  so this shows more of the record than Fleet's compact row does. Same conditional-
 *  rendering pattern the fuel chart above already uses: render nothing when there's no
 *  landing to show (the common case for any flight tracked before this feature existed),
 *  not an empty card. */
function LandingCard(props: { flightId: number }): React.JSX.Element | null {
  const [landing, setLanding] = useState<Landing | null | undefined>(undefined)
  const thresholds = useLandingThresholds()

  useEffect(() => {
    window.flightdeck.logbookGetLanding(props.flightId).then(setLanding)
  }, [props.flightId])

  if (!landing) return null

  const severity = classifyLanding(landing.verticalSpeedMs, thresholds)

  return (
    <Card className="min-w-72 flex-1">
      <CardHeader>
        <CardTitle className="text-sm">Landing</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          <DetailField
            label="Touchdown rate"
            value={
              <span className="flex items-center gap-2">
                {Math.round(msToFpm(landing.verticalSpeedMs))} fpm
                <LandingBadge severity={severity} />
              </span>
            }
          />
          <DetailField label="G-force" value={landing.gForce.toFixed(2)} />
          <DetailField
            label="Pitch / Bank / Crab"
            value={`${landing.pitchDeg.toFixed(1)}° / ${landing.bankDeg.toFixed(1)}° / ${
              landing.crabDeg != null ? `${landing.crabDeg.toFixed(1)}°` : '—'
            }`}
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
            value={
              landing.distanceFromThresholdM != null ? `${Math.round(landing.distanceFromThresholdM)} m` : '—'
            }
          />
          <DetailField
            label="Centreline offset"
            value={landing.centrelineOffsetM != null ? `${Math.round(landing.centrelineOffsetM)} m` : '—'}
          />
        </dl>
      </CardContent>
    </Card>
  )
}

function FlightDetail(props: {
  flight: Flight
  aircraft: Aircraft | undefined
  weightUnit: WeightUnit
  onBack: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const { flight, aircraft, weightUnit } = props
  const [trackPoints, setTrackPoints] = useState<TrackPoint[]>([])
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  async function handleConfirmDelete(): Promise<void> {
    setConfirmingDelete(false)
    try {
      await window.flightdeck.flightDelete(flight.id)
      props.onDeleted()
      toast.success('Flight deleted.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleViewOfpPdf(): Promise<void> {
    const opened = await window.flightdeck.logbookOpenOfpPdf(flight.id)
    if (!opened) toast.error('No OFP PDF available for this flight.')
  }

  useEffect(() => {
    window.flightdeck.trackPointList(flight.id).then(setTrackPoints)
  }, [flight.id])

  const route = useMemo(() => parseRouteFromOfpJson(flight.ofpJson), [flight.ofpJson])
  const waypoints = useMemo(() => parseWaypointsFromOfpJson(flight.ofpJson), [flight.ofpJson])

  // Elapsed minutes since the first sample reads better on a chart than raw timestamps.
  // Memoized like route/waypoints above — trackPoints only actually changes once, when
  // the fetch above resolves, so recomputing this on every unrelated re-render was pure
  // waste (previously not memoized at all, unlike its siblings here).
  const profile = useMemo(() => {
    const startMs = trackPoints.length ? new Date(trackPoints[0].tsUtc).getTime() : 0
    return trackPoints.map((p) => {
      const tMin = (new Date(p.tsUtc).getTime() - startMs) / 60000
      return {
        tMin: Math.round(tMin * 10) / 10,
        tHr: Math.round((tMin / 60) * 100) / 100,
        altFt: Math.round(mToFt(p.altitudeM)),
        iasKt: Math.round(msToKt(p.indicatedAirspeedMs)),
        mach: Math.round(p.machSpeed * 100) / 100
      }
    })
  }, [trackPoints])

  // A long-haul's duration reads better in hours than as a three/four-digit minutes axis
  // — see HOURS_AXIS_THRESHOLD_MIN above.
  const useHoursAxis = (profile.at(-1)?.tMin ?? 0) > HOURS_AXIS_THRESHOLD_MIN
  const timeAxisKey = useHoursAxis ? 'tHr' : 'tMin'
  const timeAxisUnit = useHoursAxis ? ' hr' : ' min'

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
          Back to logbook
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingDelete(true)}>
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
        <LandingCard flightId={flight.id} />
      </div>

      <div className="h-[min(36vh,360px)] min-h-56">
        <FlightMap live={false} route={route} waypoints={waypoints} trackPoints={trackPoints} />
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
                    dataKey={timeAxisKey}
                    unit={timeAxisUnit}
                    stroke={CHART_AXIS_COLOR}
                    tick={{ fill: CHART_AXIS_COLOR }}
                  />
                  <YAxis unit=" ft" width={70} stroke={CHART_AXIS_COLOR} tick={{ fill: CHART_AXIS_COLOR }} />
                  <Tooltip
                    formatter={(value) => `${value} ft`}
                    labelFormatter={(label) => `${label}${timeAxisUnit}`}
                    contentStyle={CHART_TOOLTIP_STYLE}
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
                    dataKey={timeAxisKey}
                    unit={timeAxisUnit}
                    stroke={CHART_AXIS_COLOR}
                    tick={{ fill: CHART_AXIS_COLOR }}
                  />
                  <YAxis
                    unit={speedMode === 'ias' ? ' kt' : ''}
                    width={60}
                    stroke={CHART_AXIS_COLOR}
                    tick={{ fill: CHART_AXIS_COLOR }}
                    tickFormatter={speedMode === 'mach' ? (v: number) => v.toFixed(2) : undefined}
                  />
                  <Tooltip
                    formatter={(value) =>
                      speedMode === 'ias' ? `${value} kt` : `M${Number(value).toFixed(2)}`
                    }
                    labelFormatter={(label) => `${label}${timeAxisUnit}`}
                    contentStyle={CHART_TOOLTIP_STYLE}
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

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this flight?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the flight and its landing, GSX invoice, and track data permanently. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

type SortKey = 'date' | 'flight' | 'route' | 'aircraft' | 'block' | 'air' | 'fuel'
type SortDir = 'asc' | 'desc'

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'flight', label: 'Flight' },
  { key: 'route', label: 'Route' },
  { key: 'aircraft', label: 'Aircraft' },
  { key: 'block', label: 'Block' },
  { key: 'air', label: 'Air' },
  { key: 'fuel', label: 'Fuel burn' }
]

function compareFlights(
  a: Flight,
  b: Flight,
  key: SortKey,
  registrationFor: (aircraftId: number) => string
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
    case 'air':
      return (a.airMinutes ?? 0) - (b.airMinutes ?? 0)
    case 'fuel':
      return (a.fuelBurnKg ?? 0) - (b.fuelBurnKg ?? 0)
  }
}

function SortableHead(props: {
  sortKey: SortKey
  label: string
  activeKey: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
}): React.JSX.Element {
  const active = props.sortKey === props.activeKey
  return (
    <TableHead
      onClick={() => props.onSort(props.sortKey)}
      className="cursor-pointer select-none whitespace-nowrap"
    >
      <span className="inline-flex items-center gap-1">
        {props.label}
        {active &&
          (props.dir === 'asc' ? (
            <ArrowUp className="size-3.5 text-muted-foreground" />
          ) : (
            <ArrowDown className="size-3.5 text-muted-foreground" />
          ))}
      </span>
    </TableHead>
  )
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

export function LogbookView(props: { weightUnit: WeightUnit }): React.JSX.Element {
  const [flights, setFlights] = useState<Flight[]>([])
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [stats, setStats] = useState<LogbookStats | null>(null)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  function reload(): Promise<void> {
    return Promise.all([
      window.flightdeck.logbookListCompletedFlights(),
      window.flightdeck.aircraftList(),
      window.flightdeck.logbookGetStats()
    ]).then(([flightList, aircraftList, logbookStats]) => {
      setFlights(flightList)
      setAircraft(aircraftList)
      setStats(logbookStats)
    })
  }

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [])

  function registrationFor(aircraftId: number): string {
    return aircraft.find((a) => a.id === aircraftId)?.registration ?? `#${aircraftId}`
  }

  function handleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  if (view.kind === 'detail') {
    const flight = flights.find((f) => f.id === view.id)
    if (!flight) return <p className="text-sm text-muted-foreground">Flight not found.</p>
    return (
      <FlightDetail
        flight={flight}
        aircraft={aircraft.find((a) => a.id === flight.aircraftId)}
        weightUnit={props.weightUnit}
        onBack={() => setView({ kind: 'list' })}
        onDeleted={() => {
          setView({ kind: 'list' })
          reload()
        }}
      />
    )
  }

  const sortedFlights = [...flights].sort((a, b) => {
    const cmp = compareFlights(a, b, sortKey, registrationFor)
    return sortDir === 'asc' ? cmp : -cmp
  })

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
              <TableHead>Air</TableHead>
              <TableHead>Fuel burn</TableHead>
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
                  <TableCell>{formatMinutes(f.airMinutes)}</TableCell>
                  <TableCell>{formatWeight(f.fuelBurnKg, props.weightUnit)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  )
}
