/** An aircraft's detail page. */

import { Archive, ArchiveRestore, ArrowLeft, ArrowRightLeft, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isRetired } from '@shared/aircraft'
import type { Aircraft, AircraftLastParked, FleetStats } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AircraftPhoto } from '../AircraftPhoto'
import {
  AircraftFlightsCard,
  AirlineLabel,
  DetailField,
  LandingHistoryCard,
  SimBriefProfileCard
} from './DetailCards'
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
 * An aircraft's detail page: actions, the retired / replaced note, the identity card with its
 * photo and totals, the SimBrief profile, its flights and its landing history.
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
    <div className="flex flex-col gap-4">
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
                  value={locationLabel(currentIcao, props.lastParked)}
                />
                <DetailField
                  label={t('fleetView.detail.fields.totalHours')}
                  value={s ? s.totalHours.toFixed(1) : '0.0'}
                />
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
