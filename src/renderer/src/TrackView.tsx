import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ActiveTracking, Aircraft, DispatchOfp, Flight, ProcedureSelection, SimTelemetry, TrackPoint } from '@shared/ipc'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { AirlineLogo } from './AirlineLogo'
import { FlightMap } from './FlightMap'
import { useConfirm } from './hooks/useConfirm'
import { ProcedureSelector } from './ProcedureSelector'
import { useLiveWaypoints, type ProcedureAirports } from './procedureSelection'

/** "Flight Num: [airline logo] BAW31   A35K · G-XWBS" — the identity strip shown for a
 *  flight on this page, whether it's actively being tracked or just queued up to start. */
function FlightIdentity(props: { flightNumber: string; aircraft: Aircraft | undefined }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5 text-sm text-foreground">
      <span className="font-medium text-foreground">Flight Num:</span>
      <AirlineLogo iata={props.aircraft?.operatorIata ?? null} />
      <span>{props.flightNumber}</span>
      {props.aircraft && (
        <span className="text-muted-foreground">
          {props.aircraft.icaoType} · {props.aircraft.registration}
        </span>
      )}
    </span>
  )
}


export function TrackView(props: {
  /** The OFP most recently fetched in Dispatch, not yet saved as a flight — last-resort
   *  preview so a route shows up here even before "Save as planned flight" is clicked. */
  previewOfp?: DispatchOfp | null
  /** Live sim telemetry, shown as a small overlay on the map. */
  telemetry?: SimTelemetry | null
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
}): React.JSX.Element {
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [flights, setFlights] = useState<Flight[]>([])
  const [active, setActive] = useState<ActiveTracking | null>(null)
  const [trackPoints, setTrackPoints] = useState<TrackPoint[]>([])
  const [starting, setStarting] = useState(false)
  const [confirm, confirmDialog] = useConfirm()
  const [completedLabel, setCompletedLabel] = useState<string | null>(null)
  // The onTrackingPoint listener below is registered once on mount, so it closes over
  // whatever `flights`/`props.onFlightEnded` were at that time — refs kept in step with
  // the real values let it use both without going stale.
  const flightsRef = useRef<Flight[]>([])
  const onFlightEndedRef = useRef(props.onFlightEnded)

  function reload(): Promise<void> {
    return Promise.all([window.winglog.aircraftList(), window.winglog.flightList()]).then(
      ([aircraftList, flightList]) => {
        setAircraft(aircraftList)
        setFlights(flightList)
      }
    )
  }

  useEffect(() => {
    flightsRef.current = flights
  }, [flights])

  useEffect(() => {
    onFlightEndedRef.current = props.onFlightEnded
  }, [props.onFlightEnded])

  useEffect(() => {
    reload()
    window.winglog.trackingGetActive().then((a) => {
      setActive(a)
      if (a) window.winglog.trackPointList(a.flightId).then(setTrackPoints)
    })
    const unsubscribe = window.winglog.onTrackingPoint((point) => {
      if (point.phase === 'shutdown') {
        // Auto-completed (as opposed to a manual "Finish & save") — clear the banner and
        // the map's trail immediately rather than leaving them showing a flight the
        // backend already completed. Matters most for a turnaround: staying on this page
        // between legs means there's no page remount to accidentally paper over it.
        const completed = flightsRef.current.find((f) => f.id === point.flightId)
        setCompletedLabel(completed?.flightNumber ?? `Flight #${point.flightId}`)
        setActive(null)
        setTrackPoints([])
        reload()
        onFlightEndedRef.current?.()
        return
      }
      setTrackPoints((current) =>
        current.length && current[0].flightId !== point.flightId ? [point] : [...current, point]
      )
      setActive({ flightId: point.flightId, phase: point.phase })
    })
    return unsubscribe
  }, [])

  async function handleStart(flightId: number): Promise<void> {
    setStarting(true)
    try {
      await window.winglog.trackingStart(flightId)
      setActive(await window.winglog.trackingGetActive())
      setTrackPoints([])
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  async function handleCancelActive(): Promise<void> {
    const ok = await confirm({
      title: `Cancel ${activeLabel}?`,
      description: 'The flight will be marked abandoned rather than completed.',
      confirmLabel: 'Cancel flight',
      destructive: true
    })
    if (!ok) return
    try {
      await window.winglog.trackingStop()
      setActive(null)
      setTrackPoints([])
      await reload()
      props.onFlightEnded?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleFinish(): Promise<void> {
    const ok = await confirm({
      title: `Finish ${activeLabel} now?`,
      description: 'Ends tracking immediately and saves the flight as completed.',
      confirmLabel: 'Finish & save'
    })
    if (!ok) return
    try {
      await window.winglog.trackingFinish()
      setActive(null)
      setTrackPoints([])
      await reload()
      props.onFlightEnded?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCancelPlanned(id: number, label: string): Promise<void> {
    const ok = await confirm({
      title: `Cancel ${label}?`,
      description: 'This planned flight will be abandoned.',
      confirmLabel: 'Cancel flight',
      destructive: true
    })
    if (!ok) return
    try {
      await window.winglog.flightCancel(id)
      await reload()
      props.onFlightEnded?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const plannedFlights = flights.filter((f) => f.status === 'planned')
  const activeFlight = active ? flights.find((f) => f.id === active.flightId) : undefined
  const activeLabel = activeFlight?.flightNumber ?? `flight #${active?.flightId}`
  // Before tracking starts, preview the most recently planned flight (flightList already
  // orders newest-first) so a freshly-dispatched plan shows up on the map immediately
  // rather than only after "Start tracking" is clicked. If nothing's been saved yet, fall
  // back to whatever OFP Dispatch most recently fetched — so the route (and the procedure
  // dropdowns below) show up here even before "Save as planned flight". Both a Flight and a
  // DispatchOfp structurally satisfy ProcedureAirports (depIcao/arrIcao/ofpJson), so no
  // conversion needed either way.
  const previewFlight = activeFlight ?? plannedFlights[0]
  const airports: ProcedureAirports | null = previewFlight ?? props.previewOfp ?? null
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

  // Pushes the current selection to the main process whenever it changes while a flight is
  // actively being tracked — TrackingController caches it so it's available at completion
  // regardless of which trigger fires (manual finish or automatic shutdown detection,
  // neither of which round-trips through the renderer). A no-op before tracking starts.
  useEffect(() => {
    if (!active) return
    window.winglog.trackingSetProcedureSelection(props.selection).catch(() => {})
  }, [active, props.selection])

  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold text-foreground">Track</h1>

      {active ? (
        <Card>
          <CardContent className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <FlightIdentity
                flightNumber={activeLabel}
                aircraft={aircraft.find((a) => a.id === activeFlight?.aircraftId)}
              />
              <span className="text-sm text-muted-foreground">
                Phase: <span className="font-mono capitalize">{active.phase}</span>
              </span>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="destructive" size="sm" onClick={handleCancelActive}>
                Cancel flight
              </Button>
              <Button type="button" size="sm" onClick={handleFinish}>
                Finish & save
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : plannedFlights.length === 0 ? (
        <p className="text-sm text-muted-foreground">No planned flights to track — dispatch one first.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {plannedFlights.map((f) => {
            const label = f.flightNumber ?? `${f.depIcao} → ${f.arrIcao}`
            return (
              <Card key={f.id}>
                <CardContent className="flex items-center justify-between gap-4">
                  <FlightIdentity flightNumber={label} aircraft={aircraft.find((a) => a.id === f.aircraftId)} />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" disabled={starting} onClick={() => handleStart(f.id)}>
                      Start tracking
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => handleCancelPlanned(f.id, label)}
                    >
                      Cancel flight
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {airports && (
        <div className="flex items-center gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                Procedures…
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Procedures</DialogTitle>
              </DialogHeader>
              <ProcedureSelector
                airports={airports}
                selection={props.selection}
                onSelectionChange={props.onSelectionChange}
                liveWaypoints={liveWaypoints}
              />
            </DialogContent>
          </Dialog>
          <span className="text-sm text-muted-foreground">
            {[props.selection.sidIdent, props.selection.starIdent, props.selection.approachIdent]
              .filter((v): v is string => v !== null)
              .join(' · ') || 'Nothing selected yet'}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <FlightMap live route={route} waypoints={liveWaypoints} trackPoints={trackPoints} telemetry={props.telemetry} />
      </div>

      {confirmDialog}

      <AlertDialog open={completedLabel !== null} onOpenChange={(open) => !open && setCompletedLabel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Flight ended</AlertDialogTitle>
            <AlertDialogDescription>
              {completedLabel} was automatically detected as complete and saved to your logbook.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setCompletedLabel(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
