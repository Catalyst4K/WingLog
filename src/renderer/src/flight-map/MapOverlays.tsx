/** What FlightMap draws over the map: its control buttons and its readout pills. */

import { Locate, LocateFixed, Radar, Waypoints, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FlightPhase, SimTelemetry } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { displayAltitude } from '../display-altitude'
import type { TransitionAltitudes } from '../route'
import { uiMemory } from '../ui-memory'
import { msToKt } from '../units'

const MAP_CONTROL_BUTTON_CLASS_NAME = 'bg-popover/85 backdrop-blur-sm hover:bg-popover'
const PILL_CLASS_NAME =
  'rounded-full border border-border bg-popover/85 px-3 py-1 font-mono text-xs text-popover-foreground backdrop-blur-sm'

/**
 * One on/off map control: filled when on, the translucent outline style when off.
 *
 * @param props Whether it's on, its labels for each state, the handler, and its icon.
 * @returns The element.
 */
function ToggleControl(props: {
  on: boolean
  label: string
  title: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant={props.on ? 'default' : 'outline'}
      size="icon-sm"
      // "On" reads as a filled, cyan/sky-blue button rather than an icon tint —
      // `text-accent` (shadcn's subtle hover-background color, not this app's brand
      // cyan, which is `--primary`) made the "on" state nearly invisible in both
      // themes (docs/plans/map-controls.md). Backdrop blur only matters for the
      // outline style sitting over the map; the filled "on" state is opaque already.
      className={props.on ? undefined : MAP_CONTROL_BUTTON_CLASS_NAME}
      aria-label={props.label}
      title={props.title}
      aria-pressed={props.on}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  )
}

/**
 * A zoom button. A zoom from here counts as the user's own choice, which follow mode keeps.
 *
 * @param props Its label, what it does, and its icon.
 * @returns The element.
 */
function ZoomControl(props: {
  label: string
  onZoom: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      className={MAP_CONTROL_BUTTON_CLASS_NAME}
      aria-label={props.label}
      title={props.label}
      onClick={() => {
        uiMemory().liveZoomChosenByUser = true
        props.onZoom()
      }}
    >
      {props.children}
    </Button>
  )
}

/**
 * The column of buttons at the map's top right: follow and VFR (live only), taxi chart, and zoom.
 *
 * @param props Whether live; each toggle's state and handler; and the zoom handlers.
 * @returns The element.
 */
export function MapControls(props: {
  live: boolean
  followEnabled: boolean
  onToggleFollow: () => void
  vfrEnabled: boolean
  onToggleVfr: () => void
  taxiChartEnabled: boolean
  onToggleTaxiChart: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const followLabel = props.followEnabled ? t('flightMap.stopCentering') : t('flightMap.centerOnAircraft')
  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1.5">
      {props.live && (
        <ToggleControl
          on={props.followEnabled}
          label={followLabel}
          title={followLabel}
          onClick={props.onToggleFollow}
        >
          {props.followEnabled ? <LocateFixed /> : <Locate />}
        </ToggleControl>
      )}
      {props.live && (
        <ToggleControl
          on={props.vfrEnabled}
          label={props.vfrEnabled ? t('flightMap.hideVfrOverlay') : t('flightMap.showVfrOverlay')}
          title={props.vfrEnabled ? t('flightMap.hideVfrOverlay') : t('flightMap.showVfrOverlayTitle')}
          onClick={props.onToggleVfr}
        >
          <Radar />
        </ToggleControl>
      )}
      <ToggleControl
        on={props.taxiChartEnabled}
        label={props.taxiChartEnabled ? t('flightMap.hideTaxiChart') : t('flightMap.showTaxiChart')}
        title={props.taxiChartEnabled ? t('flightMap.hideTaxiChart') : t('flightMap.showTaxiChartTitle')}
        onClick={props.onToggleTaxiChart}
      >
        <Waypoints />
      </ToggleControl>
      <ZoomControl label={t('flightMap.zoomIn')} onZoom={props.onZoomIn}>
        <ZoomIn />
      </ZoomControl>
      <ZoomControl label={t('flightMap.zoomOut')} onZoom={props.onZoomOut}>
        <ZoomOut />
      </ZoomControl>
    </div>
  )
}

/**
 * The live map's IAS, altitude and heading pill at the bottom left. The altitude reads
 * pressure or true altitude by phase, as the aircraft's own PFD would (display-altitude.ts).
 *
 * @param props The live telemetry (null before the sim connects), the flight's phase, and the
 *   OFP's transition altitude and level.
 * @returns The element.
 */
function TelemetryReadout(props: {
  telemetry: SimTelemetry | null | undefined
  phase: FlightPhase | undefined
  transition: TransitionAltitudes | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const { telemetry } = props
  const na = t('flightMap.na')
  const speed = telemetry ? `${Math.round(msToKt(telemetry.indicatedAirspeedMs))} kt` : na
  const altitude = telemetry
    ? `${Math.round(
        displayAltitude(
          {
            altitudeM: telemetry.altitudeM,
            pressureAltitudeM: telemetry.pressureAltitudeM,
            phase: props.phase ?? 'cruise'
          },
          props.transition
        ).valueFt
      ).toLocaleString()} ft`
    : na
  const heading = telemetry ? `${Math.round(telemetry.headingTrueDeg)}°` : na
  return (
    <div className={`absolute bottom-3 left-3 ${PILL_CLASS_NAME}`}>
      {t('flightMap.speed')} {speed} · {t('flightMap.altitude')} {altitude} · {t('flightMap.heading')}{' '}
      {heading}
    </div>
  )
}

/**
 * The VFR overlay's nearest-airfield pill at the top left.
 *
 * @param props The nearest airfield's text.
 * @returns The element.
 */
function NearestAirfieldPill(props: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className={`absolute top-3 left-3 ${PILL_CLASS_NAME}`} aria-label={t('flightMap.nearestAirfield')}>
      {t('flightMap.nearest')} {props.text}
    </div>
  )
}

/**
 * The taxi chart's loading pill at the bottom right.
 *
 * @param props The airport whose chart is loading.
 * @returns The element.
 */
function TaxiChartLoadingPill(props: { icao: string }): React.JSX.Element {
  const { t } = useTranslation()
  const label = t('flightMap.loadingTaxiChart', { icao: props.icao })
  return (
    <div className={`absolute right-3 bottom-3 ${PILL_CLASS_NAME}`} aria-label={label}>
      {label}
    </div>
  )
}

/**
 * The pills over the map: live telemetry, the nearest airfield (VFR overlay on), the taxi
 * chart's loading state, and the approximate-route caption.
 *
 * @param props Whether live, with its telemetry, phase and transition; the VFR overlay's and
 *   taxi chart's state; and whether the route is approximate.
 * @returns The element.
 */
export function MapPills(props: {
  live: boolean
  telemetry: SimTelemetry | null | undefined
  phase: FlightPhase | undefined
  transition: TransitionAltitudes | null
  vfr: { enabled: boolean; nearestText: string | null }
  taxiChart: { enabled: boolean; loadingIcao: string | null }
  routeIsApproximate: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { live, vfr, taxiChart } = props
  return (
    <>
      {live && (
        <TelemetryReadout telemetry={props.telemetry} phase={props.phase} transition={props.transition} />
      )}
      {live && vfr.enabled && vfr.nearestText && <NearestAirfieldPill text={vfr.nearestText} />}
      {taxiChart.enabled && taxiChart.loadingIcao && <TaxiChartLoadingPill icao={taxiChart.loadingIcao} />}
      {props.routeIsApproximate && (
        <div className="absolute bottom-3 left-3 rounded-full border border-border bg-popover/85 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
          {t('flightMap.approximateRoute')}
        </div>
      )}
    </>
  )
}
