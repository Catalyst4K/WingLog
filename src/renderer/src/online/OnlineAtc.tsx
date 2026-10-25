/**
 * Who is online at the flight's airports (winglog-backend docs/plans/vatsim-build.md, Step 4): each controller's position, callsign and
 * frequency, and each ATIS with its letter and text. Frequencies are only shown, never tuned. Every string here came from a network feed,
 * so it is rendered as text only. Enroute controllers are not listed: neither network gives them a position.
 * On the PC a button beside Weather and Procedures opens it in a pop-up (Callum, 2026-10-25: as a card above the map it took too much
 * room); on the phone it is a folded section.
 */
import { useTranslation } from 'react-i18next'
import type { NetworkControllers, OnlineAirportStations, OnlineStationPosition } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
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
 * @returns The network's name and the flight's airports, or null while there is nothing to show (no network chosen, or no flight tracked).
 */
function useOnlineAtc(): { network: string; airports: OnlineAirportStations[] } | null {
  const { network, airports } = useSafeLiveTopic('networkControllers', NOBODY)
  if (!network || airports.length === 0) return null
  return { network: network === 'ivao' ? 'IVAO' : 'VATSIM', airports }
}

/**
 * @param props The flight's airports.
 * @returns Each airport's controllers and ATIS, and the note that enroute controllers are not listed.
 */
function AtcList(props: { airports: OnlineAirportStations[] }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      {props.airports.map((airport) => (
        <Airport key={airport.icao} airport={airport} />
      ))}
      <p className="text-xs text-muted-foreground">{t('online.atc.enrouteNote')}</p>
    </div>
  )
}

/**
 * The PC's "VATSIM ATC (2)…" button, the count being the controllers online at the flight's airports, and the list in a pop-up.
 *
 * @returns The button, or nothing while there is nothing to show.
 */
export function OnlineAtcButton(): React.JSX.Element | null {
  const { t } = useTranslation()
  const atc = useOnlineAtc()
  if (!atc) return null
  const online = atc.airports.reduce((sum, airport) => sum + airport.stations.length, 0)
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t('online.atc.button', { network: atc.network, online })}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('online.atc.title', { network: atc.network })}</DialogTitle>
        </DialogHeader>
        {/* A busy event's three airports can be long: the list scrolls inside the pop-up. */}
        <div className="max-h-[70vh] overflow-y-auto pr-1">
          <AtcList airports={atc.airports} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * @returns The phone's folded section of the same list, or nothing while there is nothing to show.
 */
export function OnlineAtcSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const atc = useOnlineAtc()
  if (!atc) return null
  return (
    <details className="border-b border-border bg-card px-3 py-1.5 text-xs">
      <summary className="cursor-pointer font-medium">
        {t('online.atc.title', { network: atc.network })}
      </summary>
      <div className="pt-2">
        <AtcList airports={atc.airports} />
      </div>
    </details>
  )
}
