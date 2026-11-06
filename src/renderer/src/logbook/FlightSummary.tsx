/** A Logbook flight's heading and its summary strip (winglog-backend docs/plans/v2-design.md, "The screens": Logbook flight). */

import { useTranslation } from 'react-i18next'
import type { Aircraft, Flight, WeightUnit } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatCell, StatStrip } from '@/components/StatStrip'
import { displayIcao } from '../display-icao'
import { asyncHandler } from '../report-error'
import { formatMinutes, formatWeight } from '../units'
import { formatDate, isFreeFlight } from './logbook-format'

/**
 * The flight's heading as on the canvas (r3-flight): its number large with the route in the mono face and a quiet line of date, aircraft
 * and type under them, the OFP and add-to-fleet buttons beside it, then a thin box of figures: block and air time, fuel burn with the
 * plan's figure under it in magenta, and whether it was flown online.
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
  const subtitle = [
    formatDate(flight.actualOutUtc),
    aircraft?.registration ?? flight.simRegistration,
    aircraft?.icaoType ?? flight.simIcaoType
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-[18px] gap-y-1">
          <h2 className="m-0 text-[28px] font-semibold">{flight.flightNumber ?? '—'}</h2>
          <span className="font-mono text-lg">
            {displayIcao(flight.depIcao)} → {displayIcao(flight.arrIcao)}
          </span>
          {freeFlight && (
            <Badge variant="outline" className="text-xs font-normal">
              {t('logbookView.freeFlight')}
            </Badge>
          )}
          <span className="text-muted-foreground">{subtitle}</span>
        </div>
        <div className="flex items-center gap-2">
          {flight.ofpJson && (
            <Button
              type="button"
              variant="outline"
              onClick={asyncHandler('LogbookView handleViewOfpPdf', props.onViewOfpPdf)}
            >
              {t('logbookView.viewOfpPdf')}
            </Button>
          )}
          {freeFlight && flight.aircraftId == null && (
            <Button type="button" variant="outline" onClick={props.onAddToFleet}>
              {t('logbookView.addToFleet')}
            </Button>
          )}
        </div>
      </div>
      <StatStrip>
        <StatCell label={t('logbookView.fields.blockTime')}>{formatMinutes(flight.blockMinutes)}</StatCell>
        <StatCell label={t('logbookView.fields.airTime')}>{formatMinutes(flight.airMinutes)}</StatCell>
        <StatCell
          label={t('logbookView.fields.fuelBurn')}
          plan={
            flight.fuelPlannedKg != null
              ? `${t('logbookView.fields.planned')} ${formatWeight(flight.fuelPlannedKg, weightUnit)}`
              : undefined
          }
        >
          {formatWeight(flight.fuelBurnKg, weightUnit)}
        </StatCell>
        <StatCell label={t('logbookView.fields.online')}>
          {flight.onlineNetwork
            ? `${flight.onlineNetwork === 'ivao' ? 'IVAO' : 'VATSIM'} · ${flight.onlineCallsign ?? '—'}`
            : t('logbookView.fields.offline')}
        </StatCell>
      </StatStrip>
    </section>
  )
}
