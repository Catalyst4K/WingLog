/** A Logbook flight's heading and its summary strip (winglog-backend docs/plans/v2-design.md, "The screens": Logbook flight). */

import { useTranslation } from 'react-i18next'
import type { Aircraft, Flight, WeightUnit } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { displayIcao } from '../display-icao'
import { asyncHandler } from '../report-error'
import { formatMinutes, formatWeight } from '../units'
import { formatDate, isFreeFlight } from './logbook-format'

/**
 * One cell of the strip: a quiet label over a figure in the mono face.
 *
 * @param props The label and what goes under it.
 * @returns The element.
 */
function StripCell(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-36 flex-1 flex-col gap-0.5 border-l border-border px-3 py-2 first:border-l-0">
      <dt className="text-xs text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 font-mono text-sm break-words text-foreground">{props.children}</dd>
    </div>
  )
}

/**
 * The flight's heading (its number, route and free-flight badge, with the OFP and add-to-fleet buttons) and a strip under it:
 * aircraft, date, block and air time, fuel burn with the planned figure in magenta beside it, and the online network. The strip is a
 * boxed row of cells divided by hairlines, not a card with a title.
 *
 * @param props The flight, its fleet aircraft, the weight unit, and the two button handlers.
 * @returns The element.
 */
export function FlightSummary(props: {
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
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-medium">
          {flight.flightNumber ? `${flight.flightNumber} — ` : ''}
          {displayIcao(flight.depIcao)} → {displayIcao(flight.arrIcao)}
          {freeFlight && (
            <Badge variant="outline" className="text-xs font-normal">
              {t('logbookView.freeFlight')}
            </Badge>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {flight.ofpJson && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={asyncHandler('LogbookView handleViewOfpPdf', props.onViewOfpPdf)}
            >
              {t('logbookView.viewOfpPdf')}
            </Button>
          )}
          {freeFlight && flight.aircraftId == null && (
            <Button type="button" variant="outline" size="sm" onClick={props.onAddToFleet}>
              {t('logbookView.addToFleet')}
            </Button>
          )}
        </div>
      </div>
      <dl className="flex flex-wrap overflow-hidden rounded-md bg-card">
        <StripCell label={t('logbookView.fields.aircraft')}>
          {aircraft?.registration ?? flight.simRegistration ?? '—'}
        </StripCell>
        <StripCell label={t('logbookView.fields.date')}>{formatDate(flight.actualOutUtc)}</StripCell>
        <StripCell label={t('logbookView.fields.blockTime')}>{formatMinutes(flight.blockMinutes)}</StripCell>
        <StripCell label={t('logbookView.fields.airTime')}>{formatMinutes(flight.airMinutes)}</StripCell>
        <StripCell label={t('logbookView.fields.fuelBurn')}>
          {formatWeight(flight.fuelBurnKg, weightUnit)}
          {flight.fuelPlannedKg != null && (
            <span className="ml-2 text-plan">
              {t('logbookView.fields.planned')} {formatWeight(flight.fuelPlannedKg, weightUnit)}
            </span>
          )}
        </StripCell>
        {flight.onlineNetwork && (
          <StripCell label={t('logbookView.fields.online')}>
            {`${flight.onlineNetwork === 'ivao' ? 'IVAO' : 'VATSIM'} · ${flight.onlineCallsign ?? '—'}`}
          </StripCell>
        )}
      </dl>
    </section>
  )
}
