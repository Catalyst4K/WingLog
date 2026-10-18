/** The cards on an aircraft's detail page: SimBrief profile, flights and landing history. */

import { winglogApi } from '../data/winglog-api'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Aircraft, AircraftLanding, Flight } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AirlineLogo } from '../AirlineLogo'
import { LandingBadge } from '../LandingBadge'
import { LandingScoreBadge } from '../LandingScoreBadge'
import { formatMinutes, msToFpm, msToKt } from '../units'
import { formatDate } from './fleet-format'
import { runAsync } from '../report-error'

/**
 * An airline's logo and name.
 *
 * @param props The operator name and its IATA code.
 * @returns The element.
 */
export function AirlineLabel(props: {
  operator: string | null
  operatorIata: string | null
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <AirlineLogo iata={props.operatorIata} />
      {props.operator ?? '—'}
    </span>
  )
}

/**
 * One label and value pair in a definition list.
 *
 * @param props The label and the value.
 * @returns The element.
 */
export function DetailField(props: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="text-foreground">{props.value}</dd>
    </>
  )
}

/**
 * Display only (docs/plans/simbrief-airframe-picker.md) — picking or creating a profile
 * now lives entirely in AircraftForm.tsx's edit view, not here. Three states, per
 * docs/decisions.md's fleet-simbrief-airframe entry, just makes the current link between a
 * fleet aircraft and its SimBrief profile visible and one click away to view:
 * - a custom profile is set: show its registration/type (from the label the picker cached
 *   when it was set — falls back to the raw id for one set before this plan, or typed by
 *   hand), and a link to view it on SimBrief.
 * - no custom profile, but a SimBrief default type is chosen: show its type, plus
 *   engine/developer from the cached label when the picker set it.
 * - nothing set at all: explain the (usually fine) fallback.
 *
 * @param props The aircraft.
 * @returns The element.
 */
export function SimBriefProfileCard(props: { aircraft: Aircraft }): React.JSX.Element {
  const { t } = useTranslation()
  const a = props.aircraft

  function openAirframes(): void {
    runAsync('fleet: open airframes page', winglogApi().dispatchOpenSimBriefAirframes(a.simbriefAirframeId))
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">{t('fleetView.simbriefProfile.cardTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {a.simbriefAirframeId ? (
          <>
            <p className="text-foreground">
              {t('fleetView.simbriefProfile.custom')}{' '}
              {a.simbriefAirframeRegistration ? (
                <>
                  {a.simbriefAirframeRegistration}
                  {a.simbriefAirframeEngines ? ` (${a.simbriefAirframeEngines})` : ''}
                </>
              ) : (
                <span className="font-mono">{a.simbriefAirframeId}</span>
              )}
            </p>
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={openAirframes}>
              {t('fleetView.simbriefProfile.openInSimBrief')}
            </Button>
          </>
        ) : a.simbriefType ? (
          <p className="text-foreground">
            {a.simbriefAirframeDeveloper ? (
              <>
                {a.simbriefAirframeDeveloper}
                {a.simbriefAirframeEngines ? ` — ${a.simbriefAirframeEngines}` : ''}
              </>
            ) : (
              <>
                {t('fleetView.simbriefProfile.usingDefault')}{' '}
                <span className="font-mono">{a.simbriefType}</span>
              </>
            )}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {t('fleetView.simbriefProfile.noProfile', { icaoType: a.icaoType })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Fleet's per-aircraft landing history, per docs/decisions.md's landing-analysis entry —
 * not per-flight (Logbook's job), but how this specific tail has actually been landed
 * over its life in the fleet. Empty state is the common case for a while: only flights
 * tracked since this feature shipped have a landing record at all.
 *
 * @param props The aircraft.
 * @returns The element.
 */
export function LandingHistoryCard(props: { aircraftId: number }): React.JSX.Element {
  const { t } = useTranslation()
  const [landings, setLandings] = useState<AircraftLanding[]>([])

  useEffect(() => {
    runAsync(
      'FleetView fleetListLandings',
      winglogApi().fleetListLandings(props.aircraftId).then(setLandings)
    )
  }, [props.aircraftId])

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">{t('fleetView.landingHistory.cardTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {landings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('fleetView.landingHistory.empty')}</p>
        ) : (
          <div className="flex flex-col gap-1.5 text-sm">
            {landings.map((l) => {
              const fpm = Math.round(msToFpm(l.verticalSpeedMs))
              return (
                <div key={l.id} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {new Date(l.touchdownTsUtc).toLocaleDateString()}
                  </span>
                  <span className="font-mono tabular-nums text-foreground">{fpm} fpm</span>
                  <span className="text-foreground">
                    {l.arrIcao} {l.runwayIdent ?? '—'}
                  </span>
                  <span className="text-muted-foreground">
                    {l.crosswindMs != null
                      ? t('fleetView.landingHistory.crosswind', {
                          kt: Math.round(msToKt(Math.abs(l.crosswindMs)))
                        })
                      : '—'}
                  </span>
                  <LandingScoreBadge score={l.score} />
                  <LandingBadge severity={l.severity} />
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * An aircraft's own completed flights (docs/plans/fleet-redesign.md #2) — scrollable
 * rather than paginated per Callum's ask, same fixed-height/overflow-y-auto pattern as
 * LandingHistoryCard above so the detail page's own layout doesn't grow unbounded with
 * flight count (his real fleet has one aircraft with well over a hundred). Rows are
 * clickable, jumping to that flight's Logbook detail — the app's first cross-view
 * navigation, confirmed wanted rather than assumed.
 *
 * @param props The aircraft, and what to do when a flight is opened.
 * @returns The element.
 */
export function AircraftFlightsCard(props: {
  aircraftId: number
  onOpenFlight: (flightId: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [flights, setFlights] = useState<Flight[]>([])

  useEffect(() => {
    runAsync('FleetView fleetListFlights', winglogApi().fleetListFlights(props.aircraftId).then(setFlights))
  }, [props.aircraftId])

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">{t('fleetView.flights.cardTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {flights.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('fleetView.flights.empty')}</p>
        ) : (
          <div className="flex max-h-64 flex-col divide-y divide-border overflow-y-auto">
            {flights.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => props.onOpenFlight(f.id)}
                className="flex cursor-pointer items-center justify-between gap-3 px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-muted"
              >
                <span className="text-muted-foreground">{formatDate(f.actualOutUtc)}</span>
                <span className="text-foreground">{f.flightNumber ?? '—'}</span>
                <span className="text-foreground">
                  {f.depIcao} → {f.arrIcao}
                </span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {formatMinutes(f.blockMinutes)}
                </span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
