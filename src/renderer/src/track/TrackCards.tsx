/** The Track tab's cards: the tracked flight, the cards shown when nothing is tracked, the toolbar and the end dialog. */

import { useTranslation } from 'react-i18next'
import type {
  ActiveTracking,
  Aircraft,
  LogbookFlight,
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
import { PlanMark } from '@/components/PlanMark'
import { displayIcao, realIcao } from '../display-icao'
import { flightLabel } from '../flight-label'
import { FreeFlightAirport } from '../FreeFlightAirport'
import { MetarPanel } from '../MetarPanel'
import { OnlineAtcButton } from '../online/OnlineAtc'
import { PrefileButtons } from '../online/PrefileButtons'
import { winglogApi } from '../data/winglog-api'
import type { ProcedureAirports } from '@shared/procedure-selection'
import { NavdataCycleNote } from '../navdata/NavdataCycle'
import { ProcedureSelector } from '../ProcedureSelector'
import { asyncHandler } from '../report-error'
import { formatDuration, formatElapsed, formatUtcTime, type TrackTimes } from '../track-times'
import type { FreeFlightBanner } from './use-track-state'
import { PhaseLights } from './PhaseLights'

/**
 * The flight's identity as on the canvas (r3-track): its number large, the aircraft's type and registration quiet beside it and, for a
 * flight with a plan, the route. Falls back to simIcaoType/simRegistration (a free flight tracked with no fleet aircraft —
 * free-flight-tracking.md's "don't add to fleet" option) when there's no linked Aircraft to read type/registration from.
 *
 * @param props The flight number, the fleet aircraft, what the sim reports, and the route to show.
 * @returns The element.
 */
function FlightIdentity(props: {
  flightNumber: string
  aircraft: Aircraft | undefined
  simIcaoType?: string | null
  simRegistration?: string | null
  route?: string
}): React.JSX.Element {
  const icaoType = props.aircraft?.icaoType ?? props.simIcaoType
  const registration = props.aircraft?.registration ?? props.simRegistration
  return (
    <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
      <span className="flex items-center gap-3">
        <AirlineLogo iata={props.aircraft?.operatorIata ?? null} size={30} />
        <h2 className="m-0 font-display text-[32px] leading-[1.1] font-bold tracking-[-0.02em]">
          {props.flightNumber}
        </h2>
      </span>
      {(icaoType || registration) && (
        <span className="text-muted-foreground">{[icaoType, registration].filter(Boolean).join(' · ')}</span>
      )}
      {props.route && <span className="text-[17px]">{props.route}</span>}
    </div>
  )
}

/**
 * The ETA large in Golos (the one figure in it) and, beside it quietly, the plan's time for the same moment; how far the estimate is off
 * the schedule follows it (track-times.ts).
 *
 * @param props ETA and the offset from the schedule.
 * @returns The element.
 */
function EtaReadout(props: { times: TrackTimes }): React.JSX.Element {
  const { t } = useTranslation()
  const { times } = props
  const vs = times.vsScheduleMin
  // The plan's time is the estimate less how far it is after the schedule.
  const planMs = times.etaMs !== null && vs !== null ? times.etaMs - vs * 60_000 : null
  return (
    <div className="text-sm text-muted-foreground">
      {t(times.etaIsPlanned ? 'trackView.times.etaPlanned' : 'trackView.times.eta')}{' '}
      <span className="ml-1 font-display text-2xl font-bold tracking-[-0.02em] text-foreground">
        {formatUtcTime(times.etaMs)}
      </span>
      {planMs !== null && !times.etaIsPlanned && (
        <span className="ml-2.5 font-mono">
          {t('trackView.times.plan')} {formatUtcTime(planMs)}
        </span>
      )}
      {vs !== null && !times.etaIsPlanned && (
        <span className="ml-2">
          (
          {vs === 0
            ? t('trackView.times.onTime')
            : t('trackView.times.vsSchedule', { value: `${vs > 0 ? '+' : '−'}${Math.abs(vs)}` })}
          )
        </span>
      )}
    </div>
  )
}

/**
 * How long the flight has run and how long is left, under the plan's procedures.
 *
 * @param props ET and time remaining.
 * @returns The element.
 */
function FlownReadout(props: { times: TrackTimes }): React.JSX.Element {
  const { t } = useTranslation()
  const { times } = props
  return (
    <div className="text-sm text-muted-foreground">
      <span>{t('trackView.times.flown')}</span>{' '}
      <span className="font-mono text-foreground">{formatElapsed(times.elapsedMs)}</span>
      <span aria-hidden="true" className="mx-2">
        ·
      </span>
      <span>{t('trackView.times.toGo')}</span>{' '}
      <span className="font-mono text-foreground">{formatDuration(times.remainingMs)}</span>
    </div>
  )
}

/**
 * The flight being tracked, as the canvas draws it: who, the phase, the ETA beside the plan's, Cancel and Finish, and a free flight's
 * editable airports.
 *
 * @param props The tracking state, the flight and its aircraft, the times, and the handlers.
 * @returns The element.
 */
export function ActiveFlightCard(props: {
  active: ActiveTracking
  flight: LogbookFlight | undefined
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
    <section
      className="flex flex-col gap-3 border-b border-border pb-4"
      aria-label={t('trackView.flightInProgress')}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3.5 pt-2">
        <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
          <FlightIdentity
            flightNumber={props.label}
            aircraft={props.aircraft}
            simIcaoType={flight?.simIcaoType}
            simRegistration={flight?.simRegistration}
            route={
              flight?.hasOfp ? `${displayIcao(flight.depIcao)} → ${displayIcao(flight.arrIcao)}` : undefined
            }
          />
          <PhaseLights phase={props.active.phase} />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3.5">
          <EtaReadout times={props.times} />
          <div className="flex gap-2">
            {flight?.hasOfp && (
              <PrefileButtons file={(network) => winglogApi().onlinePrefileForFlight(flight.id, network)} />
            )}
            <Button
              type="button"
              variant="destructive"
              onClick={asyncHandler('TrackView handleCancelActive', props.onCancel)}
            >
              {t('trackView.cancelFlight')}
            </Button>
            <Button
              type="button"
              className="font-semibold"
              onClick={asyncHandler('TrackView handleFinish', props.onFinish)}
            >
              {t('trackView.finishAndSave')}
            </Button>
          </div>
        </div>
      </div>
      {flight && !flight.hasOfp && (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
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
        </div>
      )}
    </section>
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
  plannedFlights: LogbookFlight[]
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
 * The procedures chosen so far with a Change button (the Procedures dialog), the Weather and online ATC dialogs beside them, and, while a
 * flight is tracked, how long it has flown and how long is left.
 *
 * @param props The flight's airports, the procedure selection and its change handler, the wind unit, and the times.
 * @returns The element.
 */
export function FlightToolbar(props: {
  airports: ProcedureAirports | null
  selection: ProcedureSelection
  onSelectionChange: (next: ProcedureSelection) => void
  windSpeedUnit: WindSpeedUnit
  /** The flight's times, shown once it is tracked. */
  times?: TrackTimes
  tracking?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { airports, selection } = props
  const chosen = [
    selection.arrivalIcao ? t('trackView.alternateIcao', { icao: selection.arrivalIcao }) : null,
    selection.sidIdent,
    selection.starIdent,
    selection.approachIdent
  ].filter((v): v is string => v !== null)
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        {airports && !(airports.depIcao === 'ZZZZ' && airports.arrIcao === 'ZZZZ') && (
          <>
            <span className="text-sm text-muted-foreground">{t('trackView.procedures')}</span>
            {/* The chosen procedures are the plan: plain text with the plan's rule (winglog-backend docs/plans/v2-design.md); none chosen is quiet text. */}
            {chosen.length > 0 ? (
              <PlanMark>{chosen.join(' · ')}</PlanMark>
            ) : (
              <span className="text-sm text-muted-foreground">{t('trackView.nothingSelectedYet')}</span>
            )}
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('trackView.proceduresEllipsis')}
                >
                  {t('trackView.change')}
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{t('trackView.procedures')}</DialogTitle>
                </DialogHeader>
                <NavdataCycleNote />
                <ProcedureSelector
                  airports={airports}
                  selection={selection}
                  onSelectionChange={props.onSelectionChange}
                />
              </DialogContent>
            </Dialog>
          </>
        )}
        {/* Weather for the departure, destination and alternate of whatever is being flown —
         *  for a free flight, whatever was set in the card above — plus a Custom airport. */}
        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              {t('trackView.weatherEllipsis')}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-xl">
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
        {/* Who is online at the flight's airports, while a network is chosen and a flight is tracked. */}
        <OnlineAtcButton />
      </div>
      {props.tracking && props.times && <FlownReadout times={props.times} />}
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
