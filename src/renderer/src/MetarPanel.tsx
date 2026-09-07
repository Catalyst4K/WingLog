import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { MetarReport, WindSpeedUnit } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AirportSearch } from './AirportSearch'
import { formatWind, parseWindGroup } from './metar-wind'

type Slot = 'departure' | 'destination' | 'alternate' | 'custom'

const FLIGHT_CATEGORY_CLASS: Record<NonNullable<MetarReport['flightCategory']>, string> = {
  VFR: 'text-success',
  MVFR: 'text-primary',
  IFR: 'text-destructive',
  LIFR: 'text-destructive font-semibold'
}

function formatObservedAgo(observedUtc: string): string {
  if (!observedUtc) return ''
  const minutes = Math.round((Date.now() - new Date(observedUtc).getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.round(minutes / 60)} h ago`
}

function MetarBody(props: {
  icao: string | null
  loading: boolean
  report: MetarReport | undefined
  windSpeedUnit: WindSpeedUnit
}): React.JSX.Element {
  if (!props.icao) return <p className="text-xs text-muted-foreground">No airport set.</p>
  if (props.loading && !props.report) return <p className="text-xs text-muted-foreground">Fetching…</p>
  if (!props.report) return <p className="text-xs text-muted-foreground">No current METAR for {props.icao}.</p>
  // Parsed client-side, display-only — the raw text below is always the source of truth,
  // never rewritten in place (docs/plans/flight-test-findings-2026-09-06.md #5).
  const wind = parseWindGroup(props.report.rawText)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-foreground">{props.icao}</span>
        {props.report.flightCategory && (
          <span className={`text-xs font-semibold ${FLIGHT_CATEGORY_CLASS[props.report.flightCategory]}`}>
            {props.report.flightCategory}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{formatObservedAgo(props.report.observedUtc)}</span>
      </div>
      {wind && <p className="text-xs text-foreground">{formatWind(wind, props.windSpeedUnit)}</p>}
      <p className="font-mono text-xs break-words text-foreground">{props.report.rawText}</p>
    </div>
  )
}

/**
 * Sits in Dispatch's right-hand column, above the imported/created plan's details —
 * departure/destination/alternate come from the fetched OFP once there is one, or the
 * "Plan a flight" panel's own selections before that; "Custom" is a free airport search
 * for anything else — a fuel stop, a diversion candidate, wherever. Fetches all four in
 * one batched call (docs/decisions.md, 2026-09-02) rather than one request per tab, and
 * only for slots that actually have a real 4-letter code.
 */
export function MetarPanel(props: {
  depIcao: string | null
  arrIcao: string | null
  altnIcao: string | null
  windSpeedUnit: WindSpeedUnit
}): React.JSX.Element {
  const [tab, setTab] = useState<Slot>('departure')
  const [customIcao, setCustomIcao] = useState('')
  const [debouncedCustomIcao, setDebouncedCustomIcao] = useState('')
  const [metars, setMetars] = useState<Record<string, MetarReport>>({})
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

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
      window.winglog
        .weatherGetMetars(codes)
        .then((reports) => {
          if (cancelled) return
          setMetars(Object.fromEntries(reports.map((r) => [r.icao, r])))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
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
    <Card size="sm">
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Slot)} className="gap-2">
          <div className="flex items-center gap-2">
            <TabsList className="w-full flex-1">
              <TabsTrigger value="departure" className="px-1.5 text-xs">
                Dep
              </TabsTrigger>
              <TabsTrigger value="destination" className="px-1.5 text-xs">
                Dest
              </TabsTrigger>
              <TabsTrigger value="alternate" className="px-1.5 text-xs">
                Altn
              </TabsTrigger>
              <TabsTrigger value="custom" className="px-1.5 text-xs">
                Custom
              </TabsTrigger>
            </TabsList>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setRefreshKey((k) => k + 1)}
              title="Refresh METAR"
            >
              <RefreshCw />
            </Button>
          </div>
          <TabsContent value="departure">
            <MetarBody
              icao={props.depIcao}
              loading={loading}
              report={reportFor(props.depIcao)}
              windSpeedUnit={props.windSpeedUnit}
            />
          </TabsContent>
          <TabsContent value="destination">
            <MetarBody
              icao={props.arrIcao}
              loading={loading}
              report={reportFor(props.arrIcao)}
              windSpeedUnit={props.windSpeedUnit}
            />
          </TabsContent>
          <TabsContent value="alternate">
            <MetarBody
              icao={props.altnIcao}
              loading={loading}
              report={reportFor(props.altnIcao)}
              windSpeedUnit={props.windSpeedUnit}
            />
          </TabsContent>
          <TabsContent value="custom" className="flex flex-col gap-2">
            <AirportSearch value={customIcao} onChange={setCustomIcao} placeholder="Enter an ICAO code" />
            <MetarBody
              icao={customIcao || null}
              loading={loading}
              report={reportFor(customIcao)}
              windSpeedUnit={props.windSpeedUnit}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
