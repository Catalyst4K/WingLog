/** The pages besides Track: the flight plan's figures with the weather, ground services and ATC. */

import { Fragment, useMemo } from 'react'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { parseOfp } from '@shared/simbrief-ofp'
import type { DispatchOfp, LanFlight } from '@shared/ipc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { OfpDetails } from '@/dispatch/DispatchCards'
import { MetarPanel } from '@/MetarPanel'
import { GsxRemotePanel } from '@/GsxRemotePanel'
import { BeyondAtcPanel } from '@/BeyondAtcPanel'
import { realIcao } from '@/display-icao'
import { formatWeight } from '@/units'
import { formatUtcTime } from '@/track-times'
import { FlightBanner } from './TrackPage'
import type { LanConnection } from './lan-connection'
import type { PageId } from './NavBar'
import type { PcSettings } from './use-pc-settings'

/**
 * @param link The link to the PC.
 * @returns The flight the PC is showing (tracked, or the newest planned), or null.
 */
function useFlight(link: LanConnection): LanFlight | null {
  const snapshot = useSyncExternalStore(
    (notify) => link.onFlight(() => notify()),
    () => link.flight
  )
  return snapshot?.flight ?? null
}

/**
 * @param ofpJson The flight's stored SimBrief OFP, or null.
 * @returns The OFP read the way the Dispatch screen reads it, or null when there is none or it cannot be read.
 */
function readOfp(ofpJson: string | null): DispatchOfp | null {
  if (!ofpJson) return null
  try {
    return { ...parseOfp(JSON.parse(ofpJson)), ofpJson, matchedAircraftId: null }
  } catch {
    return null
  }
}

/**
 * The flight plan's figures, as the Dispatch screen shows them: aircraft, cruise altitude, times, fuel, passengers and cargo, weights, cost
 * index, step climbs and the route, with the weather for the departure, destination and alternate (and any other airport) above them.
 * Nothing to import or generate here: that stays at the PC.
 *
 * @param props The PC's flight, and the PC's unit settings.
 * @returns The element.
 */
function DispatchPage({
  flight,
  settings
}: {
  flight: LanFlight | null
  settings: PcSettings
}): React.JSX.Element {
  const { t } = useTranslation()
  const ofp = useMemo(() => readOfp(flight?.ofpJson ?? null), [flight?.ofpJson])
  return (
    <div className="flex flex-col gap-3 p-3">
      <h1 className="font-heading text-xl font-semibold">{t('app.tabs.dispatch')}</h1>
      <MetarPanel
        depIcao={realIcao(flight?.depIcao)}
        arrIcao={realIcao(flight?.arrIcao)}
        altnIcao={realIcao(ofp?.altnIcao)}
        windSpeedUnit={settings.windSpeedUnit}
      />
      {ofp ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t('dispatchView.ofpTitle', {
                flightNumber: ofp.flightNumber,
                dep: ofp.depIcao,
                arr: ofp.arrIcao,
                altn: ofp.altnIcao
              })}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <OfpDetails ofp={ofp} weightUnit={settings.weightUnit} altitudeUnit={settings.altitudeUnit} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">{t('lanPage.noPlan')}</p>
      )}
    </div>
  )
}

/**
 * What the ground crew will be asked for, from the flight plan: the fuel to uplift, the passengers and cargo to load, the weights and the
 * scheduled times. It sits above GSX's own menu so the figures to request are in front of you while you use it.
 *
 * @param props The flight plan's OFP and the PC's weight unit.
 * @returns The element.
 */
function GroundLoadsCard({ ofp, settings }: { ofp: DispatchOfp; settings: PcSettings }): React.JSX.Element {
  const { t } = useTranslation()
  const unit = settings.weightUnit
  const rows: [string, string][] = [
    [t('dispatchView.fields.plannedFuel'), formatWeight(ofp.fuelPlannedKg, unit)],
    [t('dispatchView.fields.paxCargo'), `${ofp.pax} / ${formatWeight(ofp.cargoKg, unit)}`],
    [
      t('dispatchView.fields.zfwTowLdw'),
      `${formatWeight(ofp.zfwKg, unit)} / ${formatWeight(ofp.towKg, unit)} / ${formatWeight(ofp.ldwKg, unit)}`
    ],
    [
      t('dispatchView.fields.scheduledOutIn'),
      `${formatUtcTime(Date.parse(ofp.schedOutUtc))} / ${formatUtcTime(Date.parse(ofp.schedInUtc))}`
    ]
  ]
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('lanPage.groundLoads')}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-foreground">{value}</dd>
            </Fragment>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}

/**
 * Ground services: the flight and its loads to request, above the same GSX panel as the app's.
 *
 * @param props The PC's flight and unit settings.
 * @returns The element.
 */
function GsxPage({
  flight,
  settings
}: {
  flight: LanFlight | null
  settings: PcSettings
}): React.JSX.Element {
  const { t } = useTranslation()
  const ofp = useMemo(() => readOfp(flight?.ofpJson ?? null), [flight?.ofpJson])
  return (
    <div className="flex flex-col gap-3 p-3">
      <h1 className="font-heading text-xl font-semibold">{t('gsxRemoteView.title')}</h1>
      {flight && (
        <div className="overflow-hidden rounded-lg border border-border">
          <FlightBanner flight={flight} />
        </div>
      )}
      {ofp && <GroundLoadsCard ofp={ofp} settings={settings} />}
      <GsxRemotePanel />
    </div>
  )
}

/**
 * @param props The page to show, the link, and the PC's settings.
 * @returns The element.
 */
export function InfoPage(props: {
  page: Exclude<PageId, 'track'>
  link: LanConnection
  settings: PcSettings
}): React.JSX.Element {
  const { t } = useTranslation()
  const flight = useFlight(props.link)
  if (props.page === 'dispatch') return <DispatchPage flight={flight} settings={props.settings} />
  if (props.page === 'gsx') return <GsxPage flight={flight} settings={props.settings} />
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <h1 className="font-heading text-xl font-semibold">{t('beyondAtcView.title')}</h1>
      <BeyondAtcPanel compact />
    </div>
  )
}
