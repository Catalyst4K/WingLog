/** The weather panel: Dispatch's weather card, Track's Weather pop-up and the phone's Dispatch page. METAR, and the live ATIS beneath it. */

import { winglogApi } from './data/winglog-api'
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { MetarReport, WindSpeedUnit } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  FolderTabs as Tabs,
  FolderTabsContent as TabsContent,
  FolderTabsList,
  FolderTabsTrigger
} from '@/components/FolderTabs'
import { StatusLight, type LightState } from '@/components/StatusLight'
import { AirportSearch } from './AirportSearch'
import { AtisLine } from './online/WeatherAtis'
import { atisFor, useWeatherAtis } from './online/use-weather-atis'
import { formatWind, parseWindGroup } from './metar-wind'
import { runAsync } from './report-error'

type Slot = 'departure' | 'destination' | 'alternate' | 'custom'

/** The light beside the flight category: clear to see green, marginal amber, instrument red. */
const FLIGHT_CATEGORY_LIGHT: Record<NonNullable<MetarReport['flightCategory']>, LightState> = {
  VFR: 'green',
  MVFR: 'amber',
  IFR: 'red',
  LIFR: 'red'
}

function formatObservedAgo(observedUtc: string, t: TFunction): string {
  if (!observedUtc) return ''
  const minutes = Math.round((Date.now() - new Date(observedUtc).getTime()) / 60000)
  if (minutes < 1) return t('metarPanel.justNow')
  if (minutes < 60) return t('metarPanel.minAgo', { count: minutes })
  return t('metarPanel.hAgo', { count: Math.round(minutes / 60) })
}

/**
 * The METAR panel's content: a prompt when no airport is set, a loading or error state, or the report.
 *
 * @param props The airport, loading state, report and wind speed unit.
 * @returns The content.
 */
function MetarBody(props: {
  icao: string | null
  loading: boolean
  report: MetarReport | undefined
  windSpeedUnit: WindSpeedUnit
}): React.JSX.Element {
  const { t } = useTranslation()
  if (!props.icao) return <p className="text-xs text-muted-foreground">{t('metarPanel.noAirportSet')}</p>
  if (props.loading && !props.report)
    return <p className="text-xs text-muted-foreground">{t('metarPanel.fetching')}</p>
  if (!props.report) {
    return (
      <p className="text-xs text-muted-foreground">{t('metarPanel.noCurrentMetar', { icao: props.icao })}</p>
    )
  }
  // Parsed client-side, display-only — the raw text below is always the source of truth,
  // never rewritten in place (docs/plans/flight-test-findings-2026-09-06.md #5).
  const wind = parseWindGroup(props.report.rawText)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        <span className="text-[17px] font-semibold">{props.icao}</span>
        {props.report.flightCategory && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            <StatusLight state={FLIGHT_CATEGORY_LIGHT[props.report.flightCategory]} />
            {props.report.flightCategory}
          </span>
        )}
        <span className="text-sm text-muted-foreground">
          {formatObservedAgo(props.report.observedUtc, t)}
        </span>
        {wind && (
          <>
            <span aria-hidden="true" className="-mx-2 text-sm text-muted-foreground">
              ·
            </span>
            <span className="text-sm text-muted-foreground">{formatWind(wind, props.windSpeedUnit)}</span>
          </>
        )}
      </div>
      <p className="m-0 font-mono text-[13px] leading-relaxed break-words text-muted-foreground">
        {props.report.rawText}
      </p>
    </div>
  )
}

/**
 * Sits in Dispatch's right-hand column, above the imported/created plan's details —
 * departure/destination/alternate come from the fetched OFP once there is one, or the
 * "Plan a flight" panel's own selections before that; "Custom" is a free airport search
 * for anything else — a fuel stop, a diversion candidate, wherever. Fetches all four in
 * one batched call rather than one request per tab, and
 * only for slots that actually have a real 4-letter code.
 *
 * @param props The airports to show weather for.
 * @returns The element.
 */
export function MetarPanel(props: {
  depIcao: string | null
  arrIcao: string | null
  altnIcao: string | null
  windSpeedUnit: WindSpeedUnit
}): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Slot>('departure')
  const [customIcao, setCustomIcao] = useState('')
  const [debouncedCustomIcao, setDebouncedCustomIcao] = useState('')
  const [metars, setMetars] = useState<Record<string, MetarReport>>({})
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const atis = useWeatherAtis(
    {
      departure: props.depIcao,
      destination: props.arrIcao,
      alternate: props.altnIcao,
      custom: debouncedCustomIcao
    },
    refreshKey
  )

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedCustomIcao(customIcao), 400)
    return () => clearTimeout(timer)
  }, [customIcao])

  useEffect(() => {
    const codes = [props.depIcao, props.arrIcao, props.altnIcao, debouncedCustomIcao]
      .map((c) => c?.trim().toUpperCase() ?? '')
      .filter((c) => c.length === 4)
    // Nothing to fetch — leave any existing entries in `metars` as-is rather than
    // clearing them; a slot whose code is no longer set already renders "no airport
    // set" without consulting `metars` at all, so a stale entry here is just unused,
    // never displayed.
    if (codes.length === 0) return
    let cancelled = false
    // Deferred a tick (same technique Combobox's debounce uses) so the state updates
    // below run inside a timer callback rather than synchronously in the effect body.
    const timer = setTimeout(() => {
      setLoading(true)
      runAsync(
        'MetarPanel weatherGetMetars',
        winglogApi()
          .weatherGetMetars(codes)
          .then((reports) => {
            if (cancelled) return
            setMetars(Object.fromEntries(reports.map((r) => [r.icao, r])))
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
      )
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [props.depIcao, props.arrIcao, props.altnIcao, debouncedCustomIcao, refreshKey])

  function reportFor(icao: string | null): MetarReport | undefined {
    return icao ? metars[icao.trim().toUpperCase()] : undefined
  }

  return (
    <Card className="rounded-md [--card-spacing:--spacing(5)]">
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Slot)} className="gap-3">
          <div className="flex items-center justify-between gap-2 border-b border-border">
            <FolderTabsList className="w-auto flex-wrap border-b-0">
              <FolderTabsTrigger value="departure" className="px-3 py-3 text-sm">
                {t('metarPanel.dep')}
              </FolderTabsTrigger>
              <FolderTabsTrigger value="destination" className="px-3 py-3 text-sm">
                {t('metarPanel.dest')}
              </FolderTabsTrigger>
              <FolderTabsTrigger value="alternate" className="px-3 py-3 text-sm">
                {t('metarPanel.altn')}
              </FolderTabsTrigger>
              <FolderTabsTrigger value="custom" className="px-3 py-3 text-sm">
                {t('metarPanel.custom')}
              </FolderTabsTrigger>
            </FolderTabsList>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setRefreshKey((k) => k + 1)}
              title={t('metarPanel.refreshMetar')}
              aria-label={t('metarPanel.refreshMetar')}
            >
              <RefreshCw className="text-muted-foreground" />
            </Button>
          </div>
          <TabsContent value="departure">
            <MetarBody
              icao={props.depIcao}
              loading={loading}
              report={reportFor(props.depIcao)}
              windSpeedUnit={props.windSpeedUnit}
            />
            <AtisLine answer={atisFor(atis, 'departure', props.depIcao)} network={atis?.network ?? null} />
          </TabsContent>
          <TabsContent value="destination">
            <MetarBody
              icao={props.arrIcao}
              loading={loading}
              report={reportFor(props.arrIcao)}
              windSpeedUnit={props.windSpeedUnit}
            />
            <AtisLine answer={atisFor(atis, 'destination', props.arrIcao)} network={atis?.network ?? null} />
          </TabsContent>
          <TabsContent value="alternate">
            <MetarBody
              icao={props.altnIcao}
              loading={loading}
              report={reportFor(props.altnIcao)}
              windSpeedUnit={props.windSpeedUnit}
            />
            <AtisLine answer={atisFor(atis, 'alternate', props.altnIcao)} network={atis?.network ?? null} />
          </TabsContent>
          <TabsContent value="custom" className="flex flex-col gap-2">
            <AirportSearch
              value={customIcao}
              onChange={setCustomIcao}
              placeholder={t('metarPanel.enterIcaoCode')}
            />
            <MetarBody
              icao={customIcao || null}
              loading={loading}
              report={reportFor(customIcao)}
              windSpeedUnit={props.windSpeedUnit}
            />
            <AtisLine answer={atisFor(atis, 'custom', debouncedCustomIcao)} network={atis?.network ?? null} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
