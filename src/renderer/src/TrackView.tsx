/** The Track tab: the live flight, its map, times and tracking controls. State is in track/use-track-state.ts, cards in track/TrackCards.tsx. */

import { winglogApi } from './data/winglog-api'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type {
  DispatchOfp,
  LogbookFlight,
  MapLanguage,
  ProcedureSelection,
  SimTelemetry,
  WindSpeedUnit
} from '@shared/ipc'
import { FlightMap } from './FlightMap'
import { useConfirm } from './hooks/use-confirm'
import { realIcao } from './display-icao'
import { flightLabel } from './flight-label'
import { useLiveWaypoints, type ProcedureAirports } from './procedure-selection'
import { parseTransitionAltitudes } from './route'
import { StartFreeFlightDialog } from './StartFreeFlightDialog'
import { runAsync } from './report-error'
import { ActiveFlightCard, FlightEndedDialog, FlightToolbar, NotTrackingCards } from './track/TrackCards'
import { useFlightOfp, useFreeFlightBanner, useTrackedFlights, useTrackTimes } from './track/use-track-state'

/**
 * The tracked flight, else the newest planned one, else the OFP Dispatch fetched last.
 *
 * @param flight The tracked flight, else the newest planned one.
 * @param flightOfp That flight's OFP text, once fetched.
 * @param previewOfp Dispatch's latest OFP, if any.
 * @returns The airports (and OFP) to show, or null.
 */
function previewAirports(
  flight: LogbookFlight | undefined,
  flightOfp: { flightId: number; ofpJson: string } | null,
  previewOfp: DispatchOfp | null | undefined
): ProcedureAirports | null {
  if (!flight) return previewOfp ?? null
  return {
    depIcao: flight.depIcao,
    arrIcao: flight.arrIcao,
    altnIcao: flight.altnIcao,
    ofpJson: flightOfp && flightOfp.flightId === flight.id ? flightOfp.ofpJson : null
  }
}

/**
 * The Track tab.
 *
 * @param props A planned OFP to preview, live telemetry, and the map language.
 * @returns The element.
 */
export function TrackView(props: {
  /** The OFP most recently fetched in Dispatch, not yet saved as a flight — last-resort
   *  preview so a route shows up here even before "Save as planned flight" is clicked. */
  previewOfp?: DispatchOfp | null
  /** Live sim telemetry, shown as a small overlay on the map. */
  telemetry?: SimTelemetry | null
  /** Language of the map's place names (Settings → UI). */
  mapLanguage?: MapLanguage
  /** The live procedure selection — lifted to App.tsx alongside dispatchOfp so Dispatch and
   *  Track always agree on what's currently chosen (docs/plans/navdata-without-navigraph.md,
   *  Phase 5). This is the real-world workflow the feature exists for: a pilot only learns
   *  the assigned runway/STAR/approach from ATC mid-descent, so the dropdowns need to be
   *  editable here, live, not just at Dispatch time. */
  selection: ProcedureSelection
  onSelectionChange: (next: ProcedureSelection) => void
  /** Called whenever a flight stops being current here — cancelled (active or planned),
   *  finished manually, or auto-completed via shutdown detection — so Dispatch's
   *  persisted OFP reference (which otherwise survives independently of this) can be
   *  cleared too, rather than going on claiming to reference a flight that's no longer
   *  in progress. */
  onFlightEnded?: () => void
  /** Wind unit for the Weather dialog's METARs (Settings). */
  windSpeedUnit?: WindSpeedUnit
}): React.JSX.Element {
  const { t } = useTranslation()
  const tracked = useTrackedFlights(props.onFlightEnded)
  const { aircraft, flights, active, setActive, trackPoints, setTrackPoints, reload } = tracked
  const [starting, setStarting] = useState(false)
  const [confirm, confirmDialog] = useConfirm()
  const [freeFlightDialogOpen, setFreeFlightDialogOpen] = useState(false)

  const plannedFlights = flights.filter((f) => f.status === 'planned')
  const activeFlight = active ? flights.find((f) => f.id === active.flightId) : undefined
  const activeLabel = flightLabel(activeFlight)
  const banner = useFreeFlightBanner(props.telemetry, !!active || plannedFlights.length > 0)

  /**
   * Runs a tracking action that ends the current flight here, after the user confirms it.
   *
   * @param prompt The confirmation's title, description, label and style.
   * @param action The IPC call that ends it.
   */
  async function endFlight(
    prompt: Parameters<typeof confirm>[0],
    action: () => Promise<void>
  ): Promise<void> {
    if (!(await confirm(prompt))) return
    try {
      await action()
      await reload()
      props.onFlightEnded?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleStart(flightId: number): Promise<void> {
    setStarting(true)
    try {
      await winglogApi().trackingStart(flightId)
      setActive(await winglogApi().trackingGetActive())
      setTrackPoints([])
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  /** Mirrors handleStart's post-start bookkeeping — the dialog itself already handled the
   *  IPC call and its own error reporting, this only runs on success. */
  async function handleFreeFlightStarted(): Promise<void> {
    setActive(await winglogApi().trackingGetActive())
    setTrackPoints([])
    await reload()
  }

  function handleOpenFreeFlight(): void {
    if (!props.telemetry) {
      toast.error(t('trackView.notConnected'))
      return
    }
    setFreeFlightDialogOpen(true)
  }

  const handleCancelActive = (): Promise<void> =>
    endFlight(
      {
        title: t('trackView.cancelFlightTitle', { label: activeLabel }),
        description: t('trackView.cancelActiveDescription'),
        confirmLabel: t('trackView.cancelFlight'),
        destructive: true
      },
      async () => {
        await winglogApi().trackingStop()
        setActive(null)
        setTrackPoints([])
      }
    )

  const handleFinish = (): Promise<void> =>
    endFlight(
      {
        title: t('trackView.finishFlightTitle', { label: activeLabel }),
        description: t('trackView.finishDescription'),
        confirmLabel: t('trackView.finishAndSave')
      },
      async () => {
        await winglogApi().trackingFinish()
        setActive(null)
        setTrackPoints([])
      }
    )

  const handleCancelPlanned = (id: number, label: string): Promise<void> =>
    endFlight(
      {
        title: t('trackView.cancelFlightTitle', { label }),
        description: t('trackView.cancelPlannedDescription'),
        confirmLabel: t('trackView.cancelFlight'),
        destructive: true
      },
      () => winglogApi().flightCancel(id)
    )

  // Before tracking starts, preview the most recently planned flight (flightList already
  // orders newest-first) so a freshly-dispatched plan shows up on the map immediately
  // rather than only after "Start tracking" is clicked. If nothing's been saved yet, fall
  // back to whatever OFP Dispatch most recently fetched — so the route (and the procedure
  // dropdowns below) show up here even before "Save as planned flight". Both a Flight and a
  // DispatchOfp structurally satisfy ProcedureAirports (depIcao/arrIcao/ofpJson), so no
  // conversion needed either way.
  const previewFlight = activeFlight ?? plannedFlights[0]
  const flightOfp = useFlightOfp(previewFlight)
  const airports = useMemo(
    () => previewAirports(previewFlight, flightOfp, props.previewOfp),
    [previewFlight, flightOfp, props.previewOfp]
  )
  // The live route with the current selection spliced in — the same function Dispatch's
  // preview uses, so the two can never disagree (docs/plans/navdata-without-navigraph.md,
  // Phase 5).
  const liveWaypoints = useLiveWaypoints(airports, props.selection)
  // Memoized so this stays reference-stable across renders liveWaypoints itself didn't
  // change on (e.g. a telemetry update ticking TrackView) — FlightMap's fit-bounds effect
  // keys off `route`'s identity, and an unmemoized `.map()` here recreated a "new" array on
  // every one of those renders, resetting the user's zoom mid-flight (real regression,
  // caught live: memoized everywhere else this pattern appears, LogbookView included).
  const route: [number, number][] = useMemo(() => liveWaypoints.map((w) => [w.lon, w.lat]), [liveWaypoints])
  const times = useTrackTimes({ active, activeFlight, route, trackPoints, telemetry: props.telemetry })

  // For the map overlay's altitude display (docs/plans/logbook-detail-improvements.md,
  // Phase 3) — a Flight and a DispatchOfp both carry ofpJson, same as ProcedureAirports
  // above. Keyed on the string itself, not the whole `airports` object, which is recomputed
  // fresh every render.
  const airportsOfpJson = airports?.ofpJson ?? null
  const telemetryTransition = useMemo(() => parseTransitionAltitudes(airportsOfpJson), [airportsOfpJson])

  // Pushes the current selection to the main process whenever it changes while a flight is
  // actively being tracked — TrackingController caches it so it's available at completion
  // regardless of which trigger fires (manual finish or automatic shutdown detection,
  // neither of which round-trips through the renderer). A no-op before tracking starts.
  useEffect(() => {
    if (!active) return
    runAsync(
      'TrackView trackingSetProcedureSelection',
      winglogApi().trackingSetProcedureSelection(props.selection)
    )
  }, [active, props.selection])

  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold text-foreground">{t('trackView.title')}</h1>

      {active ? (
        <ActiveFlightCard
          active={active}
          flight={activeFlight}
          label={activeLabel}
          aircraft={aircraft.find((a) => a.id === activeFlight?.aircraftId)}
          times={times}
          onCancel={handleCancelActive}
          onFinish={handleFinish}
          onAirportChanged={reload}
        />
      ) : (
        <NotTrackingCards
          banner={banner}
          telemetry={props.telemetry}
          plannedFlights={plannedFlights}
          aircraft={aircraft}
          starting={starting}
          onOpenFreeFlight={handleOpenFreeFlight}
          onStart={handleStart}
          onCancelPlanned={handleCancelPlanned}
        />
      )}

      {(airports || active) && (
        <FlightToolbar
          airports={airports}
          selection={props.selection}
          onSelectionChange={props.onSelectionChange}
          liveWaypoints={liveWaypoints}
          windSpeedUnit={props.windSpeedUnit ?? 'kt'}
        />
      )}

      <div className="min-h-0 flex-1">
        <FlightMap
          live
          route={route}
          waypoints={liveWaypoints}
          trackPoints={trackPoints}
          // Only shown once tracking has officially started — before that the sim can hold
          // stale values from a previous session.
          telemetry={active ? props.telemetry : null}
          telemetryPhase={active?.phase}
          telemetryTransition={telemetryTransition}
          mapLanguage={props.mapLanguage}
          depIcao={realIcao(airports?.depIcao)}
          arrIcao={realIcao(airports?.arrIcao)}
          trackLoading={tracked.trackLoading}
        />
      </div>

      {confirmDialog}

      <StartFreeFlightDialog
        open={freeFlightDialogOpen}
        onOpenChange={setFreeFlightDialogOpen}
        telemetry={props.telemetry ?? null}
        aircraft={aircraft}
        onStarted={() => runAsync('TrackView handleFreeFlightStarted', handleFreeFlightStarted())}
      />

      <FlightEndedDialog label={tracked.completedLabel} onClose={() => tracked.setCompletedLabel(null)} />
    </div>
  )
}
