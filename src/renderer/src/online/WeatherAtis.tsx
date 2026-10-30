/**
 * The ATIS under a METAR in the weather panel: one folded line per ATIS ("VATSIM departure ATIS L · runway 27R"), the text below it when
 * pressed. Every string came from a network feed, so it is drawn as text only. The runway is main's exactly-one-runway suggestion, never
 * applied to anything. Plan: winglog-backend docs/plans/online-atis-weather.md.
 */
import { useTranslation } from 'react-i18next'
import type { AirportAtis, AtisSlot, OnlineNetwork, WeatherAtis } from '@shared/ipc'

/**
 * @param network A network.
 * @returns Its name as the pilot knows it.
 */
function networkName(network: OnlineNetwork): string {
  return network === 'ivao' ? 'IVAO' : 'VATSIM'
}

/**
 * @param atis BeyondATC's ATIS.
 * @param slot The weather tab it is shown on.
 * @returns The runways it labels that suit the tab: departures on Dep, arrivals on Dest and Altn, both on Custom, as `[label key, runways]`.
 */
function beyondAtcRunways(atis: WeatherAtis, slot: AtisSlot): [string, string][] {
  const departure = atis.departureRunways ?? []
  const arrival = atis.arrivalRunways ?? []
  const pairs: [string, string][] = []
  if (slot !== 'destination' && slot !== 'alternate' && departure.length > 0) {
    pairs.push(['online.atis.beyondatcDeparture', departure.join(', ')])
  }
  if (slot !== 'departure' && arrival.length > 0) {
    pairs.push(['online.atis.beyondatcArrival', arrival.join(', ')])
  }
  return pairs
}

/**
 * BeyondATC's own ATIS: its letter, the runways it labels for this tab, and the text. The runways are BeyondATC's labels, never applied.
 *
 * @param props The ATIS and the tab it is on.
 * @returns Its folded line and, unfolded, its runways and text.
 */
function BeyondAtcEntry(props: { atis: WeatherAtis; slot: AtisSlot }): React.JSX.Element {
  const { t } = useTranslation()
  const { atis } = props
  const name = t('online.atis.beyondatc', { code: atis.code ?? '' })
    .replace(/\s+/g, ' ')
    .trim()
  const runways = beyondAtcRunways(atis, props.slot).map(
    ([key, list]) => [key, t(key, { runways: list })] as const
  )
  const summary = [name, ...runways.slice(0, 1).map(([, text]) => text)].join(' · ')
  return (
    <details className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">
      <summary className="cursor-pointer font-medium text-foreground">{summary}</summary>
      <div className="flex flex-col gap-0.5 pt-1">
        {runways.map(([key, text]) => (
          <div key={key} className="font-medium text-foreground" title={t('online.atis.beyondatcHint')}>
            {text}
          </div>
        ))}
        {atis.lines.map((line, index) => (
          <div key={index} className="break-words text-muted-foreground">
            {line}
          </div>
        ))}
      </div>
    </details>
  )
}

/**
 * @param props One ATIS and the network's name.
 * @returns Its folded line and, unfolded, its text.
 */
function AtisEntry(props: { atis: WeatherAtis; network: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { atis } = props
  const kind = t(`online.atis.${atis.kind}`, { network: props.network, code: atis.code ?? '' })
    .replace(/\s+/g, ' ')
    .trim()
  const summary = atis.runway ? `${kind} · ${t('online.atis.runwayShort', { runway: atis.runway })}` : kind
  return (
    <details className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">
      <summary className="cursor-pointer font-medium text-foreground">{summary}</summary>
      <div className="flex flex-col gap-0.5 pt-1">
        <div className="font-mono text-muted-foreground">{atis.callsign}</div>
        {atis.runway && (
          <div className="font-medium text-foreground" title={t('online.atis.runwayHint')}>
            {t('online.atis.runway', { runway: atis.runway })}
          </div>
        )}
        {atis.lines.map((line, index) => (
          <div key={index} className="break-words text-muted-foreground">
            {line}
          </div>
        ))}
      </div>
    </details>
  )
}

/**
 * @param props The tab's answer (undefined until asked, or while it is for another airport) and the network chosen.
 * @returns The tab's ATIS lines, BeyondATC's first; a muted line when none is online or the read failed; nothing with no network chosen (unless
 *   BeyondATC has an ATIS, or could not be read) or no answer yet.
 */
export function AtisLine(props: {
  answer: AirportAtis | undefined
  network: OnlineNetwork | null
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { answer, network } = props
  if (!answer) return null
  const beyondAtcUnavailable = answer.beyondAtcUnavailable === true
  const hasBeyondAtc = answer.atis.some((atis) => atis.source === 'beyondatc')
  if (!network && !hasBeyondAtc && !beyondAtcUnavailable) return null
  const name = network ? networkName(network) : ''
  const entries = answer.atis.map((atis) =>
    atis.source === 'beyondatc' ? (
      <BeyondAtcEntry key="beyondatc" atis={atis} slot={answer.slot} />
    ) : (
      <AtisEntry key={atis.callsign} atis={atis} network={name} />
    )
  )
  const note = beyondAtcUnavailable ? (
    <p className="text-xs text-muted-foreground">{t('online.atis.beyondatcUnavailable')}</p>
  ) : null
  if (answer.atis.length === 0 && network) {
    const key = answer.state === 'unavailable' ? 'online.atis.unavailable' : 'online.atis.none'
    return (
      <div className="flex flex-col gap-1">
        {note}
        <p className="text-xs text-muted-foreground">{t(key, { network: name })}</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {note}
      {entries}
    </div>
  )
}
