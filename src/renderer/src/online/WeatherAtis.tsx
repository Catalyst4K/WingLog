/**
 * The ATIS under a METAR in the weather panel: one folded line per ATIS ("VATSIM departure ATIS L · runway 27R"), the text below it when
 * pressed. Every string came from a network feed, so it is drawn as text only. The runway is main's exactly-one-runway suggestion, never
 * applied to anything. Plan: winglog-backend docs/plans/online-atis-weather.md.
 */
import { useTranslation } from 'react-i18next'
import type { AirportAtis, OnlineNetwork, WeatherAtis } from '@shared/ipc'

/**
 * @param network A network.
 * @returns Its name as the pilot knows it.
 */
function networkName(network: OnlineNetwork): string {
  return network === 'ivao' ? 'IVAO' : 'VATSIM'
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
 * @returns The tab's ATIS lines; a muted line when none is online or the read failed; nothing with no network chosen or no answer yet.
 */
export function AtisLine(props: {
  answer: AirportAtis | undefined
  network: OnlineNetwork | null
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { answer, network } = props
  if (!answer || !network) return null
  const name = networkName(network)
  if (answer.state === 'none') {
    return <p className="text-xs text-muted-foreground">{t('online.atis.none', { network: name })}</p>
  }
  if (answer.state === 'unavailable') {
    return <p className="text-xs text-muted-foreground">{t('online.atis.unavailable', { network: name })}</p>
  }
  return (
    <div className="flex flex-col gap-1">
      {answer.atis.map((atis) => (
        <AtisEntry key={atis.callsign} atis={atis} network={name} />
      ))}
    </div>
  )
}
