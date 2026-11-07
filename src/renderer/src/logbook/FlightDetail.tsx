/** A flight's detail page: heading and summary strip, landing, map, charts and receipts. */

import { winglogApi } from '../data/winglog-api'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  Aircraft,
  Flight,
  LogbookFlight,
  LandingDistanceUnit,
  MapLanguage,
  WeightUnit
} from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { AddFlightToFleetDialog } from '../AddFlightToFleetDialog'
import { FlightMap } from '../FlightMap'
import { GsxInvoicesCard } from '../GsxInvoicesCard'
import { useConfirm } from '../hooks/use-confirm'
import { TrackToolsMenu } from './TrackToolsMenu'
import { asyncHandler, runAsync } from '../report-error'
import { isFreeFlight } from './logbook-format'
import { FlightSummary } from './FlightSummary'
import { AltitudeChart, FuelChart, SpeedChart } from './FlightCharts'
import { LandingCard } from './LandingCard'
import { SectionHeading } from '@/components/SectionHeading'
import { useFlightProfile, useFlightRoute, useFlightTrack, useTrackEstimate } from './use-flight-detail'

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
      winglogApi()
        .logbookGetFlight(listRow.id)
        .then((flight) => {
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

/**
 * A flight's detail page: the heading and summary strip, the landing, the map, the altitude and speed
 * charts, the fuel chart and GSX invoices.
 *
 * @param props The flight, its aircraft and the fleet, the units, and the navigation handlers.
 * @returns The element.
 */
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
  const { flight, weightUnit } = props
  const { trackPoints, setTrackPoints } = useFlightTrack(flight.id)
  const { estimate, estimatedLines, setEstimate } = useTrackEstimate(flight.id)
  const [confirm, confirmDialog] = useConfirm()
  const [addToFleetOpen, setAddToFleetOpen] = useState(false)
  const { displayRoute, displayWaypoints, routeIsApproximate } = useFlightRoute(flight)
  const profile = useFlightProfile(flight.ofpJson, trackPoints)
  const [speedMode, setSpeedMode] = useState<'ias' | 'mach'>('ias')

  async function handleDelete(): Promise<void> {
    const ok = await confirm({
      title: t('logbookView.deleteFlightConfirmTitle'),
      description: t('logbookView.deleteFlightConfirmDescription', { count: trackPoints.length }),
      confirmLabel: t('logbookView.deleteFlight'),
      destructive: true
    })
    if (!ok) return
    try {
      // Deleting the aircraft's most recent flight would otherwise leave it parked at an
      // airport it never reached, so ask whether to put it back.
      const impact = await winglogApi().flightDeleteLocationImpact(flight.id)
      const revertLocation =
        impact != null &&
        (await confirm({
          title: t('logbookView.revertLocationTitle'),
          description: t('logbookView.revertLocationDescription', impact),
          confirmLabel: t('logbookView.revertLocationMoveBack', { icao: impact.revertIcao }),
          cancelLabel: t('logbookView.revertLocationKeep', { icao: impact.currentIcao })
        }))
      await winglogApi().flightDelete(flight.id, revertLocation)
      props.onDeleted()
      toast.success(t('logbookView.flightDeleted'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleViewOfpPdf(): Promise<void> {
    const opened = await winglogApi().logbookOpenOfpPdf(flight.id)
    if (!opened) toast.error(t('logbookView.noOfpPdfForFlight'))
  }

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
    <div className="@container flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={props.onBack}
          className="w-fit text-muted-foreground"
        >
          <ArrowLeft />
          {props.backToAircraft ? t('logbookView.backToAircraft') : t('logbookView.backToLogbook')}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          {flight.ofpJson && (
            <Button
              type="button"
              variant="outline"
              onClick={asyncHandler('LogbookView handleViewOfpPdf', handleViewOfpPdf)}
            >
              {t('logbookView.viewOfpPdf')}
            </Button>
          )}
          {isFreeFlight(flight) && flight.aircraftId == null && (
            <Button type="button" variant="outline" onClick={() => setAddToFleetOpen(true)}>
              {t('logbookView.addToFleet')}
            </Button>
          )}
          <TrackToolsMenu
            flightId={flight.id}
            onCleaned={setTrackPoints}
            estimate={estimate}
            onEstimateChanged={setEstimate}
          />
          <Button
            type="button"
            variant="destructive"
            onClick={asyncHandler('LogbookView handleDelete', handleDelete)}
          >
            <Trash2 />
            {t('logbookView.deleteFlight')}
          </Button>
        </div>
      </div>

      <FlightSummary flight={flight} aircraft={props.aircraft} weightUnit={weightUnit} />

      <div className="flex flex-col gap-6 @3xl:flex-row @3xl:items-start">
        <section className="min-w-0 @3xl:flex-[1.5_1_0]" aria-label={t('logbookView.route')}>
          <SectionHeading
            level={3}
            title={t('logbookView.route')}
            aside={
              <span className="flex gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <svg width="22" height="6" aria-hidden="true" className="text-plan">
                    <line
                      x1="1"
                      y1="3"
                      x2="21"
                      y2="3"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeDasharray="5 3"
                    />
                  </svg>
                  {t('logbookView.planned')}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <svg width="22" height="6" aria-hidden="true" className="text-foreground">
                    <line x1="1" y1="3" x2="21" y2="3" stroke="currentColor" strokeWidth="3.4" />
                  </svg>
                  {t('logbookView.flown')}
                </span>
              </span>
            }
          />
          <div className="h-[min(44vh,420px)] min-h-64">
            <FlightMap
              live={false}
              route={displayRoute}
              waypoints={displayWaypoints}
              trackPoints={trackPoints}
              estimatedTrack={estimatedLines}
              routeIsApproximate={routeIsApproximate}
              mapLanguage={props.mapLanguage}
            />
          </div>
        </section>
        <LandingCard flightId={flight.id} landingDistanceUnit={props.landingDistanceUnit} />
      </div>

      {profile.profile.length > 1 && (
        <div className="flex flex-col gap-6 @3xl:flex-row @3xl:items-start">
          <AltitudeChart profile={profile} />
          <SpeedChart profile={profile} speedMode={speedMode} onSpeedModeChange={setSpeedMode} />
        </div>
      )}

      <div className="flex flex-col gap-6 @3xl:flex-row @3xl:items-start">
        {fuelData && <FuelChart data={fuelData} weightUnit={weightUnit} />}

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
