/** A flight's detail page: summary, map, charts and landing. */

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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AddFlightToFleetDialog } from '../AddFlightToFleetDialog'
import { displayIcao } from '../display-icao'
import { FlightMap } from '../FlightMap'
import { GsxInvoicesCard } from '../GsxInvoicesCard'
import { useConfirm } from '../hooks/use-confirm'
import { KeepCaptureButton } from '../KeepCaptureButton'
import { TrackCleanupButton } from '../TrackCleanupButton'
import { formatMinutes, formatWeight } from '../units'
import { asyncHandler, runAsync } from '../report-error'
import { formatDate, isFreeFlight } from './logbook-format'
import { DETAIL_GRID_CLASS, DetailField } from './DetailField'
import { AltitudeChart, FuelChart, SpeedChart } from './FlightCharts'
import { LandingCard } from './LandingCard'
import { useFlightProfile, useFlightRoute, useFlightTrack } from './use-flight-detail'

/**
 * The flight's summary card: its title and free-flight badge, the buttons that open its OFP
 * or add it to the fleet, and its aircraft, date, block and air time and fuel.
 *
 * @param props The flight, its fleet aircraft, the weight unit, and the two button handlers.
 * @returns The element.
 */
function FlightSummaryCard(props: {
  flight: Flight
  aircraft: Aircraft | undefined
  weightUnit: WeightUnit
  onViewOfpPdf: () => Promise<void>
  onAddToFleet: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { flight, aircraft, weightUnit } = props
  const freeFlight = isFreeFlight(flight)
  return (
    <Card className="min-w-72 flex-1">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {flight.flightNumber ? `${flight.flightNumber} — ` : ''}
          {displayIcao(flight.depIcao)} → {displayIcao(flight.arrIcao)}
          {freeFlight && (
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
              onClick={asyncHandler('LogbookView handleViewOfpPdf', props.onViewOfpPdf)}
            >
              {t('logbookView.viewOfpPdf')}
            </Button>
          </CardAction>
        )}
        {freeFlight && flight.aircraftId == null && (
          <CardAction>
            <Button type="button" variant="outline" size="sm" onClick={props.onAddToFleet}>
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
      winglogApi().logbookGetFlight(listRow.id).then((flight) => {
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
 * A flight's detail page: the summary and landing cards, the map, the altitude and speed
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
      await winglogApi().flightDelete(flight.id)
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
        <FlightSummaryCard
          flight={flight}
          aircraft={props.aircraft}
          weightUnit={weightUnit}
          onViewOfpPdf={handleViewOfpPdf}
          onAddToFleet={() => setAddToFleetOpen(true)}
        />
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

      {profile.profile.length > 1 && (
        <div className="flex flex-wrap gap-4">
          <AltitudeChart profile={profile} />
          <SpeedChart profile={profile} speedMode={speedMode} onSpeedModeChange={setSpeedMode} />
        </div>
      )}

      <div className="flex flex-wrap gap-4">
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
