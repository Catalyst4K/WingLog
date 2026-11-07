/** A Logbook flight's heading and its summary strip (winglog-backend docs/plans/v2-design.md, "The screens": Logbook flight). */

import { useTranslation } from 'react-i18next'
import type { Aircraft, Flight, WeightUnit } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { StatCell, StatStrip } from '@/components/StatStrip'
import { AirlineLogo } from '../AirlineLogo'
import { displayIcao } from '../display-icao'
import { useAirportName } from '../use-airport-name'
import { formatMinutes, formatWeight } from '../units'
import { formatFlightDate, isFreeFlight } from './logbook-format'

/**
 * The flight's heading as on the canvas (r3-flight): its number large with the route in the mono face and a quiet line of the airports'
 * names, date, aircraft and type under them, then a thin box of figures: block and air time, fuel burn with the plan's figure under it in
 * magenta, and whether it was flown online.
 *
 * @param props The flight, its fleet aircraft and the weight unit.
 * @returns The element.
 */
export function FlightSummary(props: {
  flight: Flight
  aircraft: Aircraft | undefined
  weightUnit: WeightUnit
}): React.JSX.Element {
  const { t } = useTranslation()
  const { flight, aircraft, weightUnit } = props
  const freeFlight = isFreeFlight(flight)
  const depName = useAirportName(flight.depIcao)
  const arrName = useAirportName(flight.arrIcao)
  const subtitle = [
    depName && arrName ? t('logbookView.airportsTo', { dep: depName, arr: arrName }) : null,
    formatFlightDate(flight.actualOutUtc),
    aircraft?.registration ?? flight.simRegistration,
    aircraft?.icaoType ?? flight.simIcaoType
  ]
    .filter(Boolean)
    .join(' · ')
  const route = `${displayIcao(flight.depIcao)} → ${displayIcao(flight.arrIcao)}`
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-[18px] gap-y-1">
        {flight.flightNumber ? (
          <>
            <span className="flex items-center gap-3">
              <AirlineLogo iata={aircraft?.operatorIata ?? null} size={30} />
              <h2 className="m-0 font-display text-[36px] leading-[1.1] font-bold tracking-[-0.02em]">
                {flight.flightNumber}
              </h2>
            </span>
            <span className="font-mono text-lg">{route}</span>
          </>
        ) : (
          <h2 className="m-0 font-mono text-[32px] leading-[1.1] font-medium">{route}</h2>
        )}
        {freeFlight && (
          <Badge variant="outline" className="text-xs font-normal">
            {t('logbookView.freeFlight')}
          </Badge>
        )}
        <span className="text-muted-foreground">{subtitle}</span>
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
