/** The Track tab's cards: the tracked flight, the cards shown when nothing is tracked, the toolbar and the end dialog. */

import { useTranslation } from 'react-i18next'
import type {
  ActiveTracking,
  Aircraft,
  Flight,
  ProcedureSelection,
  SimTelemetry,
  WindSpeedUnit
} from '@shared/ipc'
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
import { AirlineLogo } from '../AirlineLogo'
import { realIcao } from '../display-icao'
import { flightLabel } from '../flight-label'
import { FreeFlightAirport } from '../FreeFlightAirport'
import { MetarPanel } from '../MetarPanel'
import type { ProcedureAirports } from '../procedureSelection'
import { ProcedureSelector } from '../ProcedureSelector'
import { asyncHandler } from '../report-error'
import type { Waypoint } from '../route'
import { formatDuration, formatElapsed, formatUtcTime, type TrackTimes } from '../trackTimes'
import type { FreeFlightBanner } from './use-track-state'

/**
 * "Flight Num: [airline logo] BAW31   A35K · G-XWBS" — the identity strip shown for a
 * flight on this page, whether it's actively being tracked or just queued up to start.
 * Falls back to simIcaoType/simRegistration (a free flight tracked with no fleet
 * aircraft — free-flight-tracking.md's "don't add to fleet" option) when there's no
 * linked Aircraft to read type/registration from.
 *
 * @param props The flight number, the fleet aircraft, and what the sim reports.
 * @returns The element.
 */
function FlightIdentity(props: {
  flightNumber: string
  aircraft: Aircraft | undefined
  simIcaoType?: string | null
  simRegistration?: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const icaoType = props.aircraft?.icaoType ?? props.simIcaoType
  const registration = props.aircraft?.registration ?? props.simRegistration
  return (
    <span className="flex items-center gap-1.5 text-sm text-foreground">
      <span className="font-medium text-foreground">{t('trackView.flightNum')}</span>
      <AirlineLogo iata={props.aircraft?.operatorIata ?? null} />
      <span>{props.flightNumber}</span>
      {(icaoType || registration) && (
        <span className="text-muted-foreground">{[icaoType, registration].filter(Boolean).join(' · ')}</span>
      )}
    </span>
  )
}

/**
 * ET · time remaining · ETA, beside the phase (trackTimes.ts).
 *
 * @param props ET, time remaining and ETA.
 * @returns The element.
 */
function TimeReadouts(props: { times: TrackTimes }): React.JSX.Element {
  const { t } = useTranslation()
  const { times } = props
  const vs = times.vsScheduleMin
  return (
    <span className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
      <span>
        {t('trackView.times.et')}{' '}
        <span className="font-mono text-foreground">{formatElapsed(times.elapsedMs)}</span>
      </span>
      <span>
        {t('trackView.times.remaining')}{' '}
        <span className="font-mono text-foreground">{formatDuration(times.remainingMs)}</span>
      </span>
      <span>
        {t(times.etaIsPlanned ? 'trackView.times.etaPlanned' : 'trackView.times.eta')}{' '}
        <span className="font-mono text-foreground">{formatUtcTime(times.etaMs)}</span>
        {vs !== null && (
          <span className="ml-1">
            (
            {vs === 0
              ? t('trackView.times.onTime')
              : t('trackView.times.vsSchedule', { value: `${vs > 0 ? '+' : '−'}${Math.abs(vs)}` })}
            )
          </span>
        )}
      </span>
    </span>
  )
}

/**
 * The flight being tracked: who, the phase, the times, Cancel and Finish, and a free flight's
 * editable airports.
 *
 * @param props The tracking state, the flight and its aircraft, the times, and the handlers.
 * @returns The element.
 */
export function ActiveFlightCard(props: {
  active: ActiveTracking
  flight: Flight | undefined
  label: string
  aircraft: Aircraft | undefined
  times: TrackTimes
  onCancel: () => Promise<void>
  onFinish: () => Promise<void>
  onAirportChanged: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const flight = props.flight
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <FlightIdentity
            flightNumber={props.label}
            aircraft={props.aircraft}
            simIcaoType={flight?.simIcaoType}
            simRegistration={flight?.simRegistration}
          />
          <span className="text-sm text-muted-foreground">
            {t('trackView.phase')} <span className="font-mono capitalize">{props.active.phase}</span>
          </span>
          <TimeReadouts times={props.times} />
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={asyncHandler('TrackView handleCancelActive', props.onCancel)}
          >
            {t('trackView.cancelFlight')}
          </Button>
          <Button type="button" size="sm" onClick={asyncHandler('TrackView handleFinish', props.onFinish)}>
            {t('trackView.finishAndSave')}
          </Button>
        </div>
      </CardContent>
      {flight && !flight.ofpJson && (
        <CardContent className="flex flex-wrap gap-x-6 gap-y-2">
          <FreeFlightAirport
            key={`dep-${flight.depIcao}`}
            kind="departure"
            icao={flight.depIcao}
            onChanged={asyncHandler('TrackView reload', props.onAirportChanged)}
          />
          <FreeFlightAirport
            key={`arr-${flight.arrIcao}`}
            kind="destination"
            icao={flight.arrIcao}
            onChanged={asyncHandler('TrackView reload', props.onAirportChanged)}
          />
        </CardContent>
      )}
    </Card>
  )
}

/**
 * Nothing tracked: the free-flight banner, the free-flight card when nothing is planned, and
 * each planned flight with Start and Cancel.
 *
 * @param props The banner, the telemetry it describes, the planned flights and fleet, and the handlers.
 * @returns The element.
 */
export function NotTrackingCards(props: {
  banner: FreeFlightBanner
  telemetry: SimTelemetry | null | undefined
  plannedFlights: Flight[]
  aircraft: Aircraft[]
  starting: boolean
  onOpenFreeFlight: () => void
  onStart: (flightId: number) => Promise<void>
  onCancelPlanned: (flightId: number, label: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const aircraftName = props.telemetry?.atcId || t('trackView.anAircraft')
  return (
    <div className="flex flex-col gap-2">
      {props.banner.show && !props.banner.dismissed && (
        <Card className="border-primary/50 bg-primary/5">
          <CardContent className="flex items-center justify-between gap-4">
            <p className="text-sm text-foreground">
              {props.telemetry?.onGround
                ? t('trackView.movingOnGroundBanner', { aircraft: aircraftName })
                : t('trackView.airborneBanner', { aircraft: aircraftName })}
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={props.onOpenFreeFlight}>
                {t('trackView.startTracking')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={props.banner.dismiss}>
                {t('trackView.notNow')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {props.plannedFlights.length === 0 && (
        <Card>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t('trackView.flyingSomethingAlready')}</p>
              <p className="text-sm text-muted-foreground">{t('trackView.startTrackingNoPlanNeeded')}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={props.onOpenFreeFlight}>
              {t('trackView.freeFlight')}
            </Button>
          </CardContent>
        </Card>
      )}

      {props.plannedFlights.map((f) => {
        const label = flightLabel(f)
        return (
          <Card key={f.id}>
            <CardContent className="flex items-center justify-between gap-4">
              <FlightIdentity
                flightNumber={label}
                aircraft={props.aircraft.find((a) => a.id === f.aircraftId)}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={props.starting}
                  onClick={asyncHandler('TrackView handleStart', () => props.onStart(f.id))}
                >
                  {t('trackView.startTracking')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={asyncHandler('TrackView handleCancelPlanned', () =>
                    props.onCancelPlanned(f.id, label)
                  )}
                >
                  {t('trackView.cancelFlight')}
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

/**
 * The Weather and Procedures dialogs, and the procedures chosen so far.
 *
 * @param props The flight's airports, the procedure selection and its change handler, the live route, and the wind unit.
 * @returns The element.
 */
export function FlightToolbar(props: {
  airports: ProcedureAirports | null
  selection: ProcedureSelection
  onSelectionChange: (next: ProcedureSelection) => void
  liveWaypoints: Waypoint[]
  windSpeedUnit: WindSpeedUnit
}): React.JSX.Element {
  const { t } = useTranslation()
  const { airports, selection } = props
  return (
    <div className="flex items-center gap-2">
      {/* Weather for the departure, destination and alternate of whatever is being flown —
       *  for a free flight, whatever was set in the card above — plus a Custom airport. */}
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            {t('trackView.weatherEllipsis')}
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('trackView.weather')}</DialogTitle>
          </DialogHeader>
          <MetarPanel
            depIcao={realIcao(airports?.depIcao)}
            arrIcao={realIcao(airports?.arrIcao)}
            altnIcao={realIcao(airports?.altnIcao)}
            windSpeedUnit={props.windSpeedUnit}
          />
        </DialogContent>
      </Dialog>
      {airports && !(airports.depIcao === 'ZZZZ' && airports.arrIcao === 'ZZZZ') && (
        <>
          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                {t('trackView.proceduresEllipsis')}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>{t('trackView.procedures')}</DialogTitle>
              </DialogHeader>
              <ProcedureSelector
                airports={airports}
                selection={selection}
                onSelectionChange={props.onSelectionChange}
                liveWaypoints={props.liveWaypoints}
              />
            </DialogContent>
          </Dialog>
          <span className="text-sm text-muted-foreground">
            {[
              selection.arrivalIcao ? t('trackView.alternateIcao', { icao: selection.arrivalIcao }) : null,
              selection.sidIdent,
              selection.starIdent,
              selection.approachIdent
            ]
              .filter((v): v is string => v !== null)
              .join(' · ') || t('trackView.nothingSelectedYet')}
          </span>
        </>
      )}
    </div>
  )
}

/**
 * "Flight ended": a flight that completed on its own, by shutdown detection.
 *
 * @param props The completed flight's label (null to close), and the close handler.
 * @returns The element.
 */
export function FlightEndedDialog(props: { label: string | null; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const label = props.label ?? ''
  return (
    <AlertDialog open={props.label !== null} onOpenChange={(open) => !open && props.onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('trackView.flightEnded')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('trackView.autoDetectedComplete', { label: label.charAt(0).toUpperCase() + label.slice(1) })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={props.onClose}>{t('trackView.ok')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
