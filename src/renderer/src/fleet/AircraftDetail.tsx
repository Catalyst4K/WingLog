/** An aircraft's detail page. */

import { Archive, ArchiveRestore, ArrowLeft, ArrowRightLeft, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isRetired } from '@shared/aircraft'
import type { Aircraft, AircraftLastParked, FleetStats } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { photoSourcesOf } from '@shared/aircraft-photo'
import { AircraftPhoto } from '../AircraftPhoto'
import { AircraftFlightsCard, LandingHistoryCard, SimBriefProfileCard } from './DetailCards'
import { AirlineLogo } from '../AirlineLogo'
import { formatDate, useLocationLabel } from './fleet-format'

/**
 * The detail page's button row: back on the left, then edit, replace, retire or unretire, and delete.
 *
 * @param props What the aircraft's state allows, and the handlers.
 * @returns The element.
 */
function DetailActions(props: {
  retired: boolean
  replaced: boolean
  onBack: () => void
  onEdit: () => void
  onReplace: () => void
  onRetire: () => void
  onUnretire: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { retired, replaced } = props
  return (
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
  )
}

/**
 * The note under the button row: "retired" when the aircraft was retired outright, or
 * "replaced by" (a link when the replacement is known) when it was replaced.
 *
 * @param props The aircraft, what replaced it, and the handler that opens the replacement.
 * @returns The element, or null for an active aircraft.
 */
function RetirementNote(props: {
  aircraft: Aircraft
  replacedBy: Aircraft | undefined
  onViewAircraft: (id: number) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const a = props.aircraft
  const { replacedBy } = props
  if (a.replacedByAircraftId === null) {
    if (!isRetired(a)) return null
    return (
      <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">
        {t('fleetView.detail.retiredNote', {
          date: a.retiredAt ? t('fleetView.detail.retiredOn', { date: formatDate(a.retiredAt) }) : ''
        })}
      </p>
    )
  }
  return (
    <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">
      {t('fleetView.detail.replacedPrefix')}{' '}
      {replacedBy ? (
        <button
          type="button"
          className="cursor-pointer font-medium text-foreground underline underline-offset-2"
          onClick={() => props.onViewAircraft(replacedBy.id)}
        >
          {replacedBy.registration}
        </button>
      ) : (
        `#${a.replacedByAircraftId}`
      )}
      .
    </p>
  )
}

/**
 * One figure under the registration: a quiet label over a value in the mono face, as large as a heading of its own.
 *
 * @param props The label and the value.
 * @returns The element.
 */
function Figure(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <dt className="text-[13px] text-muted-foreground">{props.label}</dt>
      <dd className="m-0 mt-0.5 font-mono text-xl">{props.children}</dd>
    </div>
  )
}

/**
 * An aircraft's detail page, as on the design canvas (r3-fleet): the actions, the retired / replaced note, then two columns. On the left
 * the photo, the registration large with its type and airline, four figures between hairlines, and the SimBrief profile row; on the right
 * its flights and its landing history as plain lists.
 *
 * @param props The aircraft, its stats, where it last parked, what replaced it, and the handlers.
 * @returns The element.
 */
export function AircraftDetail(props: {
  aircraft: Aircraft
  stats: FleetStats | undefined
  lastParked: AircraftLastParked | undefined
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
  const currentIcao = a.currentIcao ?? s?.lastArrIcao ?? null
  const locationLabel = useLocationLabel()
  return (
    <div className="@container flex flex-col gap-4">
      <DetailActions
        retired={isRetired(a)}
        replaced={a.replacedByAircraftId !== null}
        onBack={props.onBack}
        onEdit={props.onEdit}
        onReplace={props.onReplace}
        onRetire={props.onRetire}
        onUnretire={props.onUnretire}
        onDelete={props.onDelete}
      />

      <RetirementNote aircraft={a} replacedBy={props.replacedBy} onViewAircraft={props.onViewAircraft} />

      <div className="flex flex-col gap-7 @3xl:flex-row @3xl:items-start">
        <section className="@container min-w-0 @3xl:flex-[1.25_1_0]" aria-label={a.registration}>
          <AircraftPhoto sources={photoSourcesOf(a)} alt={`${a.registration} ${a.icaoType}`} />
          <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="m-0 flex flex-wrap items-center gap-x-3">
              <AirlineLogo iata={a.operatorIata} size={30} />
              <span className="font-display text-4xl leading-[1.1] font-bold tracking-[-0.02em]">
                {a.registration}
              </span>{' '}
              <span className="text-[17px] font-normal text-muted-foreground">{a.icaoType}</span>
            </h2>
            <span className="text-[15px]">{a.operator}</span>
          </div>
          <dl className="mt-4 mb-0 grid grid-cols-2 gap-x-5 gap-y-3 border-y border-border py-3.5 @lg:grid-cols-4">
            <Figure label={t('fleetView.detail.fields.currentAirport')}>
              {locationLabel(currentIcao, props.lastParked)}
            </Figure>
            <Figure label={t('fleetView.detail.fields.totalHours')}>
              {s ? s.totalHours.toFixed(1) : '0.0'}
            </Figure>
            <Figure label={t('fleetView.detail.fields.flights')}>{s?.totalCycles ?? 0}</Figure>
            <Figure label={t('fleetView.detail.fields.lastFlight')}>
              {formatDate(s?.lastFlightInUtc ?? null)}
            </Figure>
          </dl>
          <SimBriefProfileCard aircraft={a} />
        </section>
        <section
          className="flex min-w-0 flex-col gap-6 @3xl:flex-[1_1_0]"
          aria-label={t('fleetView.flights.cardTitle')}
        >
          <AircraftFlightsCard aircraftId={a.id} onOpenFlight={props.onOpenFlight} />
          <LandingHistoryCard aircraftId={a.id} />
        </section>
      </div>
    </div>
  )
}
