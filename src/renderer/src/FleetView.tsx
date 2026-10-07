/** The Fleet tab: the aircraft list, one aircraft's detail page, and the add / edit / replace flows. */

import { winglogApi } from './data/winglog-api'
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { isRetired } from '@shared/aircraft'
import type { Aircraft, AircraftLastParked, FleetStats, NewAircraft } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { AircraftForm } from './AircraftForm'
import { FolderTabs, FolderTabsContent, FolderTabsList, FolderTabsTrigger } from './components/FolderTabs'
import { AircraftDetail } from './fleet/AircraftDetail'
import { ActiveFleetTable, RetiredFleetTable, type FleetSortKey } from './fleet/FleetTables'
import { ReplaceAircraftDialog } from './fleet/ReplaceAircraftDialog'
import { useConfirm } from './hooks/use-confirm'
import { useResetSignal } from './hooks/use-reset-signal'
import { useSortable } from './hooks/use-sortable'
import { asyncHandler, runAsync } from './report-error'

type View = { kind: 'list' } | { kind: 'detail'; id: number } | { kind: 'new' } | { kind: 'edit'; id: number }

/**
 * The Fleet tab.
 *
 * @param props The handler that opens a flight in the Logbook, an aircraft to open first, and the tab's reset signal.
 * @returns The element.
 */
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
  const [lastParked, setLastParked] = useState<AircraftLastParked[]>([])
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, for the initial prop
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
    return Promise.all([
      winglogApi().aircraftList(),
      winglogApi().logbookFleetStats(),
      winglogApi().fleetListLastParked()
    ]).then(([aircraftList, fleetStats, parked]) => {
      setAircraft(aircraftList)
      setStats(fleetStats)
      setLastParked(parked)
    })
  }

  useEffect(() => {
    runAsync('FleetView reload', reload())
  }, [])

  async function handleCreate(data: NewAircraft): Promise<void> {
    await winglogApi().aircraftCreate(data)
    await reload()
    setView({ kind: 'list' })
  }

  async function handleUpdate(id: number, data: NewAircraft): Promise<void> {
    await winglogApi().aircraftUpdate({ id, ...data })
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
      await winglogApi().aircraftDelete(target.id)
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
      await winglogApi().aircraftRetire(target.id)
      await reload()
      toast.success(t('fleetView.toasts.retired', { registration: target.registration }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleUnretire(target: Aircraft): Promise<void> {
    try {
      await winglogApi().aircraftUnretire(target.id)
      await reload()
      toast.success(t('fleetView.toasts.unretired', { registration: target.registration }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Replaces the aircraft being replaced with the chosen one, reloads the fleet, says so and opens
   * the replacement's page. A failure is shown as a toast and rethrown.
   *
   * @param replacementId The aircraft that takes over.
   */
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
      await winglogApi().aircraftReplace(target.id, replacementId)
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
          lastParked={lastParked.find((p) => p.aircraftId === existing.id)}
          replacedBy={aircraft.find((a) => a.id === existing.replacedByAircraftId)}
          onEdit={() => setView({ kind: 'edit', id: view.id })}
          onDelete={asyncHandler('FleetView handleDelete', () => handleDelete(existing))}
          onReplace={() => setReplaceTarget(existing)}
          onRetire={asyncHandler('FleetView handleRetire', () => handleRetire(existing))}
          onUnretire={asyncHandler('FleetView handleUnretire', () => handleUnretire(existing))}
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
      <ActiveFleetTable
        rows={sortedActiveAircraft}
        stats={stats}
        lastParked={lastParked}
        sortKey={activeSortKey}
        sortDir={activeSortDir}
        onSort={handleActiveSort}
        onOpen={(id) => setView({ kind: 'detail', id })}
      />
    )

  const retiredList = (
    <RetiredFleetTable
      rows={retiredAircraft}
      fleet={aircraft}
      onOpen={(id) => setView({ kind: 'detail', id })}
    />
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
