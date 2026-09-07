import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRightLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Aircraft, AircraftLanding, Flight, FleetStats, NewAircraft } from '@shared/ipc'
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AircraftForm } from './AircraftForm'
import { AircraftPhoto } from './AircraftPhoto'
import { AirlineLogo } from './AirlineLogo'
import { useSortable } from './hooks/useSortable'
import { LandingBadge } from './LandingBadge'
import { classifyLanding } from './landing-severity'
import { SortableHead } from './SortableHead'
import { formatMinutes, msToFpm, msToKt } from './units'
import { useLandingThresholds } from './useLandingThresholds'

type View = { kind: 'list' } | { kind: 'detail'; id: number } | { kind: 'new' } | { kind: 'edit'; id: number }

type FleetSortKey = 'registration' | 'type' | 'airline' | 'location' | 'hours' | 'flights'

const FLEET_SORT_COLUMNS: { key: FleetSortKey; label: string }[] = [
  { key: 'registration', label: 'Registration' },
  { key: 'type', label: 'Type' },
  { key: 'airline', label: 'Airline' },
  { key: 'location', label: 'Location' },
  { key: 'hours', label: 'Hours' },
  { key: 'flights', label: 'Flights' }
]

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

function AirlineLabel(props: { operator: string | null; operatorIata: string | null }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <AirlineLogo iata={props.operatorIata} />
      {props.operator ?? '—'}
    </span>
  )
}

function DetailField(props: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="text-foreground">{props.value}</dd>
    </>
  )
}

/**
 * Three states, per docs/decisions.md's fleet-simbrief-airframe entry — this deliberately
 * doesn't reimplement SimBrief's own airframe editor, just makes the link between a fleet
 * aircraft and its SimBrief profile visible and one click to reach:
 * - a custom profile is set: open *that* airframe's editor directly.
 * - no custom profile, but a SimBrief default type is chosen: show it, offer to change it
 *   or create a custom one instead.
 * - nothing set at all: explain the (usually fine) fallback and offer to create a profile.
 */
function SimBriefProfileCard(props: { aircraft: Aircraft }): React.JSX.Element {
  const a = props.aircraft

  function openAirframes(): void {
    void window.flightdeck.dispatchOpenSimBriefAirframes(a.simbriefAirframeId)
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">SimBrief profile</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {a.simbriefAirframeId ? (
          <>
            <p className="text-foreground">
              Custom profile: <span className="font-mono">{a.simbriefAirframeId}</span>
            </p>
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={openAirframes}>
              Open in SimBrief
            </Button>
          </>
        ) : a.simbriefType ? (
          <>
            <p className="text-foreground">
              Using SimBrief default: <span className="font-mono">{a.simbriefType}</span>
            </p>
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={openAirframes}>
              Create a custom airframe in SimBrief
            </Button>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              No profile set — plans fall back to SimBrief's own default for {a.icaoType}, which is usually
              fine and occasionally very wrong on weights (and therefore fuel).
            </p>
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={openAirframes}>
              Create a custom airframe in SimBrief
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Fleet's per-aircraft landing history, per docs/decisions.md's landing-analysis entry —
 *  not per-flight (Logbook's job), but how this specific tail has actually been landed
 *  over its life in the fleet. Empty state is the common case for a while: only flights
 *  tracked since this feature shipped have a landing record at all. */
function LandingHistoryCard(props: { aircraftId: number }): React.JSX.Element {
  const [landings, setLandings] = useState<AircraftLanding[]>([])
  const thresholds = useLandingThresholds()

  useEffect(() => {
    window.flightdeck.fleetListLandings(props.aircraftId).then(setLandings)
  }, [props.aircraftId])

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">Landing history</CardTitle>
      </CardHeader>
      <CardContent>
        {landings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No landings recorded yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5 text-sm">
            {landings.map((l) => {
              const fpm = Math.round(msToFpm(l.verticalSpeedMs))
              const severity = classifyLanding(l.verticalSpeedMs, thresholds)
              return (
                <div key={l.id} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{new Date(l.touchdownTsUtc).toLocaleDateString()}</span>
                  <span className="font-mono tabular-nums text-foreground">{fpm} fpm</span>
                  <span className="text-foreground">{l.runwayIdent ?? '—'}</span>
                  <span className="text-muted-foreground">
                    {l.crosswindMs != null ? `${Math.round(msToKt(Math.abs(l.crosswindMs)))} kt xwind` : '—'}
                  </span>
                  <LandingBadge severity={severity} />
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** An aircraft's own completed flights (docs/plans/fleet-redesign.md #2) — scrollable
 *  rather than paginated per Callum's ask, same fixed-height/overflow-y-auto pattern as
 *  LandingHistoryCard above so the detail page's own layout doesn't grow unbounded with
 *  flight count (his real fleet has one aircraft with well over a hundred). Rows are
 *  clickable, jumping to that flight's Logbook detail — the app's first cross-view
 *  navigation, confirmed wanted rather than assumed. */
function AircraftFlightsCard(props: { aircraftId: number; onOpenFlight: (flightId: number) => void }): React.JSX.Element {
  const [flights, setFlights] = useState<Flight[]>([])

  useEffect(() => {
    window.flightdeck.fleetListFlights(props.aircraftId).then(setFlights)
  }, [props.aircraftId])

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">Flights</CardTitle>
      </CardHeader>
      <CardContent>
        {flights.length === 0 ? (
          <p className="text-sm text-muted-foreground">No completed flights yet.</p>
        ) : (
          <div className="flex max-h-64 flex-col divide-y divide-border overflow-y-auto">
            {flights.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => props.onOpenFlight(f.id)}
                className="flex items-center justify-between gap-3 px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-muted"
              >
                <span className="text-muted-foreground">{formatDate(f.actualOutUtc)}</span>
                <span className="text-foreground">{f.flightNumber ?? '—'}</span>
                <span className="text-foreground">
                  {f.depIcao} → {f.arrIcao}
                </span>
                <span className="font-mono tabular-nums text-muted-foreground">{formatMinutes(f.blockMinutes)}</span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** A livery/registration change on an airframe still being flown (docs/plans/
 *  aircraft-replacement.md) — picks an existing, active fleet aircraft to take over this
 *  one's flight history. The target list deliberately excludes already-retired aircraft:
 *  chaining a replacement onto one that's already been superseded would need its own
 *  "walk the chain" handling this plan doesn't build, and in practice a target is always
 *  still active at the moment a replace happens (it might get retired itself later, via a
 *  separate replace). */
function ReplaceAircraftDialog(props: {
  aircraft: Aircraft
  candidates: Aircraft[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (replacementId: number) => Promise<void>
}): React.JSX.Element {
  const [targetId, setTargetId] = useState<number | null>(null)
  const [flightCount, setFlightCount] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // The parent only ever mounts this component while a replace is in progress (see
  // FleetView's `{replaceTarget && <ReplaceAircraftDialog ... />}`), so a fresh mount
  // already means a fresh target/flightCount — no need to reset them on `open` here, just
  // fetch once for whichever aircraft this instance was mounted for.
  useEffect(() => {
    window.flightdeck
      .flightList()
      .then((flights) => setFlightCount(flights.filter((f) => f.aircraftId === props.aircraft.id).length))
  }, [props.aircraft.id])

  const target = props.candidates.find((c) => c.id === targetId) ?? null

  async function handleConfirm(): Promise<void> {
    if (!target) return
    setSubmitting(true)
    try {
      await props.onConfirm(target.id)
      props.onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace {props.aircraft.registration}</DialogTitle>
          <DialogDescription>
            Moves this aircraft's flight history onto another fleet aircraft and marks it
            retired — for a livery or registration change on the same physical airframe, not
            a genuine retirement.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Label className="flex flex-col items-start gap-1.5">
            Replacement aircraft
            <Select
              value={targetId != null ? String(targetId) : undefined}
              onValueChange={(v) => setTargetId(Number(v))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="— select —" />
              </SelectTrigger>
              <SelectContent>
                {props.candidates.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.registration} — {c.icaoType}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          {target && (
            <p className="text-sm text-muted-foreground">
              {flightCount === null ? 'Checking flight history…' : `${flightCount} flight(s) will move`} from{' '}
              <span className="font-medium text-foreground">{props.aircraft.registration}</span> to{' '}
              <span className="font-medium text-foreground">{target.registration}</span>;{' '}
              {props.aircraft.registration} will be marked retired. This cannot be undone from the UI.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={!target || submitting}>
            {submitting ? 'Replacing…' : 'Replace'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AircraftDetail(props: {
  aircraft: Aircraft
  stats: FleetStats | undefined
  replacedBy: Aircraft | undefined
  onEdit: () => void
  onDelete: () => void
  onReplace: () => void
  onViewAircraft: (id: number) => void
  onOpenFlight: (flightId: number) => void
  onBack: () => void
}): React.JSX.Element {
  const a = props.aircraft
  const s = props.stats
  const retired = a.replacedByAircraftId !== null
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={props.onBack} className="w-fit">
          <ArrowLeft />
          Back to fleet
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={props.onEdit}>
            <Pencil />
            Edit
          </Button>
          {!retired && (
            <Button type="button" variant="outline" size="sm" onClick={props.onReplace}>
              <ArrowRightLeft />
              Replace…
            </Button>
          )}
          <Button type="button" variant="destructive" size="sm" onClick={props.onDelete}>
            <Trash2 />
            Delete
          </Button>
        </div>
      </div>

      {retired && (
        <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">
          Retired — replaced by{' '}
          {props.replacedBy ? (
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => props.onViewAircraft(props.replacedBy!.id)}
            >
              {props.replacedBy.registration}
            </button>
          ) : (
            `#${a.replacedByAircraftId}`
          )}
          .
        </p>
      )}

      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-72 flex-1 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">
                {a.registration} — {a.icaoType}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <AircraftPhoto thumbnailUrl={a.photoThumbnailUrl} />
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                <DetailField
                  label="Airline"
                  value={<AirlineLabel operator={a.operator} operatorIata={a.operatorIata} />}
                />
                <DetailField label="Current airport" value={a.currentIcao ?? s?.lastArrIcao ?? '—'} />
                <DetailField label="Total hours" value={s ? s.totalHours.toFixed(1) : '0.0'} />
                <DetailField label="Flights" value={s?.totalCycles ?? 0} />
                <DetailField label="Last flight" value={formatDate(s?.lastFlightInUtc ?? null)} />
              </dl>
            </CardContent>
          </Card>
          <SimBriefProfileCard aircraft={a} />
        </div>
        <div className="flex min-w-72 flex-1 flex-col gap-4">
          <AircraftFlightsCard aircraftId={a.id} onOpenFlight={props.onOpenFlight} />
          <LandingHistoryCard aircraftId={a.id} />
        </div>
      </div>
    </div>
  )
}

export function FleetView(props: { onOpenFlightInLogbook: (flightId: number) => void }): React.JSX.Element {
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [stats, setStats] = useState<FleetStats[]>([])
  const [view, setView] = useState<View>({ kind: 'list' })
  const [deleteTarget, setDeleteTarget] = useState<Aircraft | null>(null)
  const [replaceTarget, setReplaceTarget] = useState<Aircraft | null>(null)

  const activeAircraft = aircraft.filter((a) => a.replacedByAircraftId === null)
  const retiredAircraft = aircraft.filter((a) => a.replacedByAircraftId !== null)

  function statsFor(aircraftId: number): FleetStats | undefined {
    return stats.find((s) => s.aircraftId === aircraftId)
  }

  const fleetComparators: Record<FleetSortKey, (a: Aircraft, b: Aircraft) => number> = {
    registration: (a, b) => a.registration.localeCompare(b.registration),
    type: (a, b) => a.icaoType.localeCompare(b.icaoType),
    airline: (a, b) => (a.operator ?? '').localeCompare(b.operator ?? ''),
    location: (a, b) =>
      (a.currentIcao ?? statsFor(a.id)?.lastArrIcao ?? '').localeCompare(
        b.currentIcao ?? statsFor(b.id)?.lastArrIcao ?? ''
      ),
    hours: (a, b) => (statsFor(a.id)?.totalHours ?? 0) - (statsFor(b.id)?.totalHours ?? 0),
    flights: (a, b) => (statsFor(a.id)?.totalCycles ?? 0) - (statsFor(b.id)?.totalCycles ?? 0)
  }
  const {
    sortKey: activeSortKey,
    sortDir: activeSortDir,
    sortedRows: sortedActiveAircraft,
    handleSort: handleActiveSort
  } = useSortable<Aircraft, FleetSortKey>(activeAircraft, fleetComparators, 'registration')

  function reload(): Promise<void> {
    return Promise.all([window.flightdeck.aircraftList(), window.flightdeck.logbookFleetStats()]).then(
      ([aircraftList, fleetStats]) => {
        setAircraft(aircraftList)
        setStats(fleetStats)
      }
    )
  }

  useEffect(() => {
    reload()
  }, [])

  async function handleCreate(data: NewAircraft): Promise<void> {
    await window.flightdeck.aircraftCreate(data)
    await reload()
    setView({ kind: 'list' })
  }

  async function handleUpdate(id: number, data: NewAircraft): Promise<void> {
    await window.flightdeck.aircraftUpdate({ id, ...data })
    await reload()
    setView({ kind: 'detail', id })
  }

  async function handleConfirmDelete(): Promise<void> {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      await window.flightdeck.aircraftDelete(target.id)
      await reload()
      setView({ kind: 'list' })
      toast.success(`Deleted ${target.registration}.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleConfirmReplace(replacementId: number): Promise<void> {
    if (!replaceTarget) return
    const target = replaceTarget
    const replacement = aircraft.find((a) => a.id === replacementId)
    try {
      await window.flightdeck.aircraftReplace(target.id, replacementId)
      await reload()
      toast.success(`${target.registration} retired, replaced by ${replacement?.registration ?? replacementId}.`)
      setView({ kind: 'detail', id: replacementId })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  if (view.kind === 'new') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-heading text-2xl font-semibold text-foreground">New aircraft</h1>
        <AircraftForm onSubmit={handleCreate} onCancel={() => setView({ kind: 'list' })} />
      </div>
    )
  }

  if (view.kind === 'edit') {
    const existing = aircraft.find((a) => a.id === view.id)
    if (!existing) return <p className="text-sm text-muted-foreground">Aircraft not found.</p>
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-heading text-2xl font-semibold text-foreground">Edit {existing.registration}</h1>
        <AircraftForm
          initial={existing}
          onSubmit={(data) => handleUpdate(view.id, data)}
          onCancel={() => setView({ kind: 'detail', id: view.id })}
        />
      </div>
    )
  }

  if (view.kind === 'detail') {
    const existing = aircraft.find((a) => a.id === view.id)
    if (!existing) return <p className="text-sm text-muted-foreground">Aircraft not found.</p>
    return (
      <>
        <AircraftDetail
          aircraft={existing}
          stats={stats.find((s) => s.aircraftId === existing.id)}
          replacedBy={aircraft.find((a) => a.id === existing.replacedByAircraftId)}
          onEdit={() => setView({ kind: 'edit', id: view.id })}
          onDelete={() => setDeleteTarget(existing)}
          onReplace={() => setReplaceTarget(existing)}
          onViewAircraft={(id) => setView({ kind: 'detail', id })}
          onOpenFlight={props.onOpenFlightInLogbook}
          onBack={() => setView({ kind: 'list' })}
        />
        <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {deleteTarget?.registration}?</AlertDialogTitle>
              <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={handleConfirmDelete}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {replaceTarget && (
          <ReplaceAircraftDialog
            aircraft={replaceTarget}
            candidates={activeAircraft.filter((a) => a.id !== replaceTarget.id)}
            open={replaceTarget !== null}
            onOpenChange={(open) => !open && setReplaceTarget(null)}
            onConfirm={handleConfirmReplace}
          />
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl font-semibold text-foreground">Fleet</h1>
        <Button type="button" size="sm" onClick={() => setView({ kind: 'new' })}>
          <Plus />
          New aircraft
        </Button>
      </div>

      {activeAircraft.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No active aircraft — add one, or import a fleet from Settings → Data.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {FLEET_SORT_COLUMNS.map((col) => (
                <SortableHead
                  key={col.key}
                  sortKey={col.key}
                  label={col.label}
                  activeKey={activeSortKey}
                  dir={activeSortDir}
                  onSort={handleActiveSort}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedActiveAircraft.map((a) => {
              const s = statsFor(a.id)
              return (
                <TableRow
                  key={a.id}
                  onClick={() => setView({ kind: 'detail', id: a.id })}
                  className="cursor-pointer"
                >
                  <TableCell className="font-medium">{a.registration}</TableCell>
                  <TableCell>{a.icaoType}</TableCell>
                  <TableCell>
                    <AirlineLabel operator={a.operator} operatorIata={a.operatorIata} />
                  </TableCell>
                  <TableCell>{a.currentIcao ?? s?.lastArrIcao ?? '—'}</TableCell>
                  <TableCell>{s ? s.totalHours.toFixed(1) : '0.0'}</TableCell>
                  <TableCell>{s?.totalCycles ?? 0}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      {retiredAircraft.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="font-heading text-lg font-semibold text-foreground">Retired</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Registration</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Replaced by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {retiredAircraft.map((a) => {
                const replacement = aircraft.find((c) => c.id === a.replacedByAircraftId)
                return (
                  <TableRow
                    key={a.id}
                    onClick={() => setView({ kind: 'detail', id: a.id })}
                    className="cursor-pointer text-muted-foreground"
                  >
                    <TableCell className="font-medium">{a.registration}</TableCell>
                    <TableCell>{a.icaoType}</TableCell>
                    <TableCell>
                      {replacement ? (
                        <button
                          type="button"
                          className="text-foreground underline underline-offset-2"
                          onClick={(e) => {
                            e.stopPropagation()
                            setView({ kind: 'detail', id: replacement.id })
                          }}
                        >
                          {replacement.registration}
                        </button>
                      ) : (
                        `#${a.replacedByAircraftId}`
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
