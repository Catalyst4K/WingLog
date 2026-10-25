/**
 * Who is online at the flight's airports (winglog-backend docs/plans/vatsim-build.md, Step 4): each controller's position, callsign and
 * frequency, and each ATIS with its letter and text. Frequencies are only shown, never tuned. Every string here came from a network feed,
 * so it is rendered as text only. Enroute controllers are not listed: neither network gives them a position.
 */
import { useTranslation } from 'react-i18next'
import type { NetworkControllers, OnlineAirportStations, OnlineStationPosition } from '@shared/ipc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useSafeLiveTopic } from '../live/use-safe-live-topic'

const NOBODY: NetworkControllers = { network: null, airports: [] }

/** Aviation abbreviations stay in English in every language. */
const POSITION_LABELS: Record<OnlineStationPosition, string> = {
  del: 'DEL',
  gnd: 'GND',
  twr: 'TWR',
  app: 'APP',
  ctr: 'CTR',
  fss: 'FSS'
}

/**
 * @param props One airport's stations.
 * @returns The airport's controllers and ATIS.
 */
function Airport({ airport }: { airport: OnlineAirportStations }): React.JSX.Element {
  const { t } = useTranslation()
  const nobody = airport.stations.length === 0 && airport.atis.length === 0
  return (
    <section aria-label={airport.icao} className="flex flex-col gap-1">
      <h3 className="font-mono text-sm font-semibold text-foreground">{airport.icao}</h3>
      {nobody && <p className="text-sm text-muted-foreground">{t('online.atc.nobody')}</p>}
      <ul className="flex flex-col gap-0.5 text-sm">
        {airport.stations.map((station) => (
          <li key={station.callsign} className="flex flex-wrap items-baseline gap-x-2">
            <span className="w-9 font-mono text-xs text-muted-foreground">
              {POSITION_LABELS[station.position]}
            </span>
            <span className="font-mono">{station.callsign}</span>
            <span className="font-mono text-foreground">{station.frequency}</span>
            {station.name && <span className="text-muted-foreground">{station.name}</span>}
          </li>
        ))}
      </ul>
      {airport.atis.map((atis) => (
        <div key={atis.callsign} className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">
          <div className="font-mono font-medium">
            ATIS {atis.code ?? ''} · {atis.callsign}
          </div>
          {atis.runway && (
            <div className="font-medium text-foreground" title={t('online.atc.runwayHint')}>
              {t('online.atc.runway', { runway: atis.runway })}
            </div>
          )}
          {atis.lines.map((line, index) => (
            <div key={index} className="break-words text-muted-foreground">
              {line}
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}

/**
 * @param props `compact` draws it as a collapsed section for the phone, instead of a card.
 * @returns The controllers online at the flight's airports, or nothing while no flight is tracked on a chosen network.
 */
export function OnlineAtcCard(props: { compact?: boolean }): React.JSX.Element | null {
  const { t } = useTranslation()
  const { network, airports } = useSafeLiveTopic('networkControllers', NOBODY)
  if (!network || airports.length === 0) return null
  const name = network === 'ivao' ? 'IVAO' : 'VATSIM'
  const title = t('online.atc.title', { network: name })
  const body = (
    <div className="flex flex-col gap-3">
      {airports.map((airport) => (
        <Airport key={airport.icao} airport={airport} />
      ))}
      <p className="text-xs text-muted-foreground">{t('online.atc.enrouteNote')}</p>
    </div>
  )
  if (props.compact) {
    return (
      <details className="border-b border-border bg-card px-3 py-1.5 text-xs">
        <summary className="cursor-pointer font-medium">{title}</summary>
        <div className="pt-2">{body}</div>
      </details>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  )
}
