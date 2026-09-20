import { useEffect, useState } from 'react'
import { Archive, ArchiveRestore, ArrowLeft, ArrowRightLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { isRetired } from '@shared/aircraft'
import type { Aircraft, AircraftLanding, Flight, FleetStats, NewAircraft } from '@shared/ipc'
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
import { FolderTabs, FolderTabsContent, FolderTabsList, FolderTabsTrigger } from './components/FolderTabs'
import { displayIcao } from './display-icao'
import { useConfirm } from './hooks/useConfirm'
import { useResetSignal } from './hooks/useResetSignal'
import { useSortable } from './hooks/useSortable'
import { LandingBadge } from './LandingBadge'
import { LandingScoreBadge } from './LandingScoreBadge'
import { SortableHead } from './SortableHead'
import { formatMinutes, msToFpm, msToKt } from './units'

type View = { kind: 'list' } | { kind: 'detail'; id: number } | { kind: 'new' } | { kind: 'edit'; id: number }

type FleetSortKey = 'registration' | 'type' | 'airline' | 'location' | 'hours' | 'flights'

function fleetSortColumns(t: TFunction): { key: FleetSortKey; label: string }[] {
  return [
    { key: 'registration', label: t('fleetView.sortColumns.registration') },
    { key: 'type', label: t('fleetView.sortColumns.type') },
    { key: 'airline', label: t('fleetView.sortColumns.airline') },
    { key: 'location', label: t('fleetView.sortColumns.location') },
    { key: 'hours', label: t('fleetView.sortColumns.hours') },
    { key: 'flights', label: t('fleetView.sortColumns.flights') }
  ]
}

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
 * Display only (docs/plans/simbrief-airframe-picker.md) — picking or creating a profile
 * now lives entirely in AircraftForm.tsx's edit view, not here. Three states, per
 * docs/decisions.md's fleet-simbrief-airframe entry, just makes the current link between a
 * fleet aircraft and its SimBrief profile visible and one click away to view:
 * - a custom profile is set: show its registration/type (from the label the picker cached
 *   when it was set — falls back to the raw id for one set before this plan, or typed by
 *   hand), and a link to view it on SimBrief.
 * - no custom profile, but a SimBrief default type is chosen: show its type, plus
 *   engine/developer from the cached label when the picker set it.
 * - nothing set at all: explain the (usually fine) fallback.
 */
function SimBriefProfileCard(props: { aircraft: Aircraft }): React.JSX.Element {
  const { t } = useTranslation()
  const a = props.aircraft

  function openAirframes(): void {
    void window.winglog.dispatchOpenSimBriefAirframes(a.simbriefAirframeId)
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">{t('fleetView.simbriefProfile.cardTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {a.simbriefAirframeId ? (
          <>
            <p className="text-foreground">
              {t('fleetView.simbriefProfile.custom')}{' '}
              {a.simbriefAirframeRegistration ? (
                <>
                  {a.simbriefAirframeRegistration}
                  {a.simbriefAirframeEngines ? ` (${a.simbriefAirframeEngines})` : ''}
                </>
              ) : (
                <span className="font-mono">{a.simbriefAirframeId}</span>
              )}
            </p>
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={openAirframes}>
              {t('fleetView.simbriefProfile.openInSimBrief')}
            </Button>
          </>
        ) : a.simbriefType ? (
          <p className="text-foreground">
            {a.simbriefAirframeDeveloper ? (
              <>
                {a.simbriefAirframeDeveloper}
                {a.simbriefAirframeEngines ? ` — ${a.simbriefAirframeEngines}` : ''}
              </>
            ) : (
              <>
                {t('fleetView.simbriefProfile.usingDefault')} <span className="font-mono">{a.simbriefType}</span>
              </>
            )}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {t('fleetView.simbriefProfile.noProfile', { icaoType: a.icaoType })}
          </p>
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
  const { t } = useTranslation()
  const [landings, setLandings] = useState<AircraftLanding[]>([])

  useEffect(() => {
    window.winglog.fleetListLandings(props.aircraftId).then(setLandings)
  }, [props.aircraftId])

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">{t('fleetView.landingHistory.cardTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {landings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('fleetView.landingHistory.empty')}</p>
        ) : (
          <div className="flex flex-col gap-1.5 text-sm">
            {landings.map((l) => {
              const fpm = Math.round(msToFpm(l.verticalSpeedMs))
              return (
                <div key={l.id} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {new Date(l.touchdownTsUtc).toLocaleDateString()}
                  </span>
                  <span className="font-mono tabular-nums text-foreground">{fpm} fpm</span>
                  <span className="text-foreground">
                    {l.arrIcao} {l.runwayIdent ?? '—'}
                  </span>
                  <span className="text-muted-foreground">
                    {l.crosswindMs != null
                      ? t('fleetView.landingHistory.crosswind', { kt: Math.round(msToKt(Math.abs(l.crosswindMs))) })
                      : '—'}
                  </span>
                  <LandingScoreBadge score={l.score} />
                  <LandingBadge severity={l.severity} />
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
function AircraftFlightsCard(props: {
  aircraftId: number
  onOpenFlight: (flightId: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [flights, setFlights] = useState<Flight[]>([])

  useEffect(() => {
    window.winglog.fleetListFlights(props.aircraftId).then(setFlights)
  }, [props.aircraftId])

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">{t('fleetView.flights.cardTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {flights.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('fleetView.flights.empty')}</p>
        ) : (
          <div className="flex max-h-64 flex-col divide-y divide-border overflow-y-auto">
            {flights.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => props.onOpenFlight(f.id)}
                className="flex cursor-pointer items-center justify-between gap-3 px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-muted"
              >
                <span className="text-muted-foreground">{formatDate(f.actualOutUtc)}</span>
                <span className="text-foreground">{f.flightNumber ?? '—'}</span>
                <span className="text-foreground">
                  {f.depIcao} → {f.arrIcao}
                </span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {formatMinutes(f.blockMinutes)}
                </span>
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
  const { t } = useTranslation()
  const [targetId, setTargetId] = useState<number | null>(null)
  const [flightCount, setFlightCount] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // The parent only ever mounts this component while a replace is in progress (see
  // FleetView's `{replaceTarget && <ReplaceAircraftDialog ... />}`), so a fresh mount
  // already means a fresh target/flightCount — no need to reset them on `open` here, just
  // fetch once for whichever aircraft this instance was mounted for.
  useEffect(() => {
    window.winglog
      .flightList()
      .then((flights) => setFlightCount(flights.filter((f) => f.aircraftId === props.aircraft.id).length))
  }, [props.aircraft.id])

  const target = props.candidates.find((c) => c.id === targetId) ?? null

  async function handleConfirm(): Promise<void> {
    /* v8 ignore start -- defensive only: the Replace button is disabled whenever `!target`,
     * so this can't fire from a real click. */
    if (!target) return
    /* v8 ignore stop */
    setSubmitting(true)
    try {
      await props.onConfirm(target.id)
      props.onOpenChange(false)
    } catch {
      // The parent already surfaces the failure via toast; swallow it here so it doesn't
      // become an unhandled rejection from this onClick handler, and leave the dialog open.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fleetView.replaceDialog.title', { registration: props.aircraft.registration })}</DialogTitle>
          <DialogDescription>{t('fleetView.replaceDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Label className="flex flex-col items-start gap-1.5">
            {t('fleetView.replaceDialog.replacementAircraft')}
            <Select
              value={targetId != null ? String(targetId) : undefined}
              onValueChange={(v) => setTargetId(Number(v))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('fleetView.replaceDialog.selectPlaceholder')} />
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
              {t('fleetView.replaceDialog.moveSummary', {
                flightsWillMove:
                  flightCount === null
                    ? t('fleetView.replaceDialog.checkingFlightHistory')
                    : t('fleetView.replaceDialog.flightsWillMove', { count: flightCount }),
                from: props.aircraft.registration,
                to: target.registration
              })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            {t('fleetView.replaceDialog.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={!target || submitting}
          >
            {submitting ? t('fleetView.replaceDialog.replacing') : t('fleetView.replaceDialog.confirm')}
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
  onRetire: () => void
  onUnretire: () => void
  onViewAircraft: (id: number) => void
  onOpenFlight: (flightId: number) => void
  onBack: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const a = props.aircraft
  const s = props.stats
  const retired = isRetired(a)
  const replaced = a.replacedByAircraftId !== null
  const currentIcao = a.currentIcao ?? s?.lastArrIcao ?? null
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={props.onBack} className="w-fit">
          <ArrowLeft />
          {t('fleetView.detail.backToFleet')}
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={props.onEdit}>
            <Pencil />
            {t('fleetView.detail.edit')}
          </Button>
          {!retired && (
            <Button type="button" variant="outline" size="sm" onClick={props.onReplace}>
              <ArrowRightLeft />
              {t('fleetView.detail.replace')}
            </Button>
          )}
          {!retired && (
            <Button type="button" variant="outline" size="sm" onClick={props.onRetire}>
              <Archive />
              {t('fleetView.detail.retire')}
            </Button>
          )}
          {retired && !replaced && (
            <Button type="button" variant="outline" size="sm" onClick={props.onUnretire}>
              <ArchiveRestore />
              {t('fleetView.detail.unretire')}
            </Button>
          )}
          <Button type="button" variant="destructive" size="sm" onClick={props.onDelete}>
            <Trash2 />
            {t('fleetView.detail.delete')}
          </Button>
        </div>
      </div>

      {retired && !replaced && (
        <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">
          {t('fleetView.detail.retiredNote', {
            date: a.retiredAt ? t('fleetView.detail.retiredOn', { date: formatDate(a.retiredAt) }) : ''
          })}
        </p>
      )}

      {replaced && (
        <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">
          {t('fleetView.detail.replacedPrefix')}{' '}
          {props.replacedBy ? (
            <button
              type="button"
              className="cursor-pointer font-medium text-foreground underline underline-offset-2"
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
                  label={t('fleetView.detail.fields.airline')}
                  value={<AirlineLabel operator={a.operator} operatorIata={a.operatorIata} />}
                />
                <DetailField
                  label={t('fleetView.detail.fields.currentAirport')}
                  value={currentIcao ? displayIcao(currentIcao) : '—'}
                />
                <DetailField label={t('fleetView.detail.fields.totalHours')} value={s ? s.totalHours.toFixed(1) : '0.0'} />
                <DetailField label={t('fleetView.detail.fields.flights')} value={s?.totalCycles ?? 0} />
                <DetailField
                  label={t('fleetView.detail.fields.lastFlight')}
                  value={formatDate(s?.lastFlightInUtc ?? null)}
                />
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

export function FleetView(props: {
  onOpenFlightInLogbook: (flightId: number, fromAircraftId: number) => void
  /** Set when Logbook's "Back" returns here for a specific aircraft, rather than the
   *  user picking one from the list. Mirrors LogbookView's own initialFlightId prop. */
  initialAircraftId?: number | null
  /** Called once initialAircraftId has been consumed — see LogbookView's
   *  onInitialFlightConsumed for why this needs to happen exactly once. */
  onInitialAircraftConsumed?: () => void
  /** Bumped by App.tsx when the Fleet tab is clicked while already active — returns to
   *  the aircraft list (docs/plans/navigation-tab-behaviour.md). See useResetSignal. */
  resetSignal?: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [stats, setStats] = useState<FleetStats[]>([])
  const [view, setView] = useState<View>(
    props.initialAircraftId != null ? { kind: 'detail', id: props.initialAircraftId } : { kind: 'list' }
  )
  const [replaceTarget, setReplaceTarget] = useState<Aircraft | null>(null)
  const [confirm, confirmDialog] = useConfirm()

  useResetSignal(props.resetSignal, () => setView({ kind: 'list' }))

  useEffect(() => {
    if (props.initialAircraftId != null) props.onInitialAircraftConsumed?.()
    // Only ever meant to run once, against the initial prop value — see the state
    // initializer above, which already captured it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeAircraft = aircraft.filter((a) => !isRetired(a))
  const retiredAircraft = aircraft.filter((a) => isRetired(a))

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
    return Promise.all([window.winglog.aircraftList(), window.winglog.logbookFleetStats()]).then(
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
    await window.winglog.aircraftCreate(data)
    await reload()
    setView({ kind: 'list' })
  }

  async function handleUpdate(id: number, data: NewAircraft): Promise<void> {
    await window.winglog.aircraftUpdate({ id, ...data })
    await reload()
    setView({ kind: 'detail', id })
  }

  async function handleDelete(target: Aircraft): Promise<void> {
    const ok = await confirm({
      title: t('fleetView.confirmDelete.title', { registration: target.registration }),
      description: t('fleetView.confirmDelete.description'),
      confirmLabel: t('fleetView.confirmDelete.confirmLabel'),
      destructive: true
    })
    if (!ok) return
    try {
      await window.winglog.aircraftDelete(target.id)
      await reload()
      setView({ kind: 'list' })
      toast.success(t('fleetView.toasts.deleted', { registration: target.registration }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRetire(target: Aircraft): Promise<void> {
    const ok = await confirm({
      title: t('fleetView.confirmRetire.title', { registration: target.registration }),
      description: t('fleetView.confirmRetire.description'),
      confirmLabel: t('fleetView.confirmRetire.confirmLabel')
    })
    if (!ok) return
    try {
      await window.winglog.aircraftRetire(target.id)
      await reload()
      toast.success(t('fleetView.toasts.retired', { registration: target.registration }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleUnretire(target: Aircraft): Promise<void> {
    try {
      await window.winglog.aircraftUnretire(target.id)
      await reload()
      toast.success(t('fleetView.toasts.unretired', { registration: target.registration }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleConfirmReplace(replacementId: number): Promise<void> {
    /* v8 ignore start -- defensive only: only ever called (as ReplaceAircraftDialog's
     * onConfirm) while that dialog is mounted, which only happens while replaceTarget is
     * set. */
    if (!replaceTarget) return
    /* v8 ignore stop */
    const target = replaceTarget
    // replacementId always comes from activeAircraft (the same `aircraft` state this closes
    // over), so it's always found — the `?? replacementId` fallback below is defensive only.
    const replacement = aircraft.find((a) => a.id === replacementId)
    try {
      await window.winglog.aircraftReplace(target.id, replacementId)
      await reload()
      /* v8 ignore start -- see the defensive-only note above `replacement` */
      toast.success(
        t('fleetView.toasts.replaced', {
          registration: target.registration,
          replacement: replacement?.registration ?? replacementId
        })
      )
      /* v8 ignore stop */
      setView({ kind: 'detail', id: replacementId })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  if (view.kind === 'new') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-heading text-2xl font-semibold text-foreground">{t('fleetView.newAircraft')}</h1>
        <AircraftForm onSubmit={handleCreate} onCancel={() => setView({ kind: 'list' })} />
      </div>
    )
  }

  if (view.kind === 'edit') {
    const existing = aircraft.find((a) => a.id === view.id)
    /* v8 ignore start -- defensive only: `view.id` is only ever set (via onEdit) to an id
     * that was just found in `aircraft` on the detail page a moment earlier, and nothing in
     * this component removes an aircraft out from under an open edit view. */
    if (!existing) return <p className="text-sm text-muted-foreground">{t('fleetView.aircraftNotFound')}</p>
    /* v8 ignore stop */
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-heading text-2xl font-semibold text-foreground">
          {t('fleetView.editAircraft', { registration: existing.registration })}
        </h1>
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
    if (!existing) return <p className="text-sm text-muted-foreground">{t('fleetView.aircraftNotFound')}</p>
    return (
      <>
        <AircraftDetail
          aircraft={existing}
          stats={stats.find((s) => s.aircraftId === existing.id)}
          replacedBy={aircraft.find((a) => a.id === existing.replacedByAircraftId)}
          onEdit={() => setView({ kind: 'edit', id: view.id })}
          onDelete={() => handleDelete(existing)}
          onReplace={() => setReplaceTarget(existing)}
          onRetire={() => void handleRetire(existing)}
          onUnretire={() => void handleUnretire(existing)}
          onViewAircraft={(id) => setView({ kind: 'detail', id })}
          onOpenFlight={(flightId) => props.onOpenFlightInLogbook(flightId, existing.id)}
          onBack={() => setView({ kind: 'list' })}
        />
        {confirmDialog}
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

  const activeList =
    activeAircraft.length === 0 ? (
      <p className="text-sm text-muted-foreground">{t('fleetView.noActiveAircraft')}</p>
    ) : (
      <Table>
        <TableHeader>
          <TableRow>
            {fleetSortColumns(t).map((col) => (
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
            const icao = a.currentIcao ?? s?.lastArrIcao ?? null
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
                <TableCell>{icao ? displayIcao(icao) : '—'}</TableCell>
                <TableCell>{s ? s.totalHours.toFixed(1) : '0.0'}</TableCell>
                <TableCell>{s?.totalCycles ?? 0}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    )

  const retiredList = (
    <div className="flex flex-col gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('fleetView.retiredTable.registration')}</TableHead>
            <TableHead>{t('fleetView.retiredTable.type')}</TableHead>
            <TableHead>{t('fleetView.retiredTable.status')}</TableHead>
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
                  {a.replacedByAircraftId === null ? (
                    t('fleetView.retiredStatus', {
                      date: a.retiredAt ? t('fleetView.detail.retiredOn', { date: formatDate(a.retiredAt) }) : ''
                    })
                  ) : replacement ? (
                    <button
                      type="button"
                      className="cursor-pointer text-foreground underline underline-offset-2"
                      onClick={(e) => {
                        e.stopPropagation()
                        setView({ kind: 'detail', id: replacement.id })
                      }}
                    >
                      {t('fleetView.replacedBy', { registration: replacement.registration })}
                    </button>
                  ) : (
                    t('fleetView.replacedByUnknown', { id: a.replacedByAircraftId })
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl font-semibold text-foreground">{t('fleetView.title')}</h1>
        <Button type="button" size="sm" onClick={() => setView({ kind: 'new' })}>
          <Plus />
          {t('fleetView.newAircraft')}
        </Button>
      </div>

      {retiredAircraft.length === 0 ? (
        activeList
      ) : (
        <FolderTabs defaultValue="active" className="gap-0">
          <FolderTabsList>
            <FolderTabsTrigger value="active">
              {t('fleetView.activeTab', { count: activeAircraft.length })}
            </FolderTabsTrigger>
            <FolderTabsTrigger value="retired">
              {t('fleetView.retiredTab', { count: retiredAircraft.length })}
            </FolderTabsTrigger>
          </FolderTabsList>
          <FolderTabsContent value="active" className="pt-4">
            {activeList}
          </FolderTabsContent>
          <FolderTabsContent value="retired" className="pt-4">
            {retiredList}
          </FolderTabsContent>
        </FolderTabs>
      )}
    </div>
  )
}
