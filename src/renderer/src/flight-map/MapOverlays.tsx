/** What FlightMap draws over the map: its control buttons and its readout pills. */

import { Locate, LocateFixed, Plane, PlaneTakeoff, Radar, Waypoints, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FlightPhase, NetworkTraffic, SimTelemetry, SimTraffic, TrafficLayers } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { displayAltitude } from '../display-altitude'
import type { TransitionAltitudes } from '@shared/route'
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
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      disabled={props.disabled}
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

/** The names shown for each network. */
const NETWORK_NAMES = { vatsim: 'VATSIM', ivao: 'IVAO' } as const

/**
 * The shared switch for the chosen network's traffic. Hidden while no network is chosen; disabled for IVAO until a VID is entered
 * (IVAO shows other pilots only to members).
 *
 * @param props The layers (the switch's state), the traffic (which network and whether it needs a VID), and the toggle.
 * @returns The element, or nothing.
 */
function NetworkTrafficButton(props: {
  layers: TrafficLayers | null
  traffic: NetworkTraffic | null
  onToggle: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const network = props.traffic?.network
  if (!network) return null
  const name = NETWORK_NAMES[network]
  const needsVid = props.traffic?.state === 'needsVid'
  // IVAO without a VID shows nothing whatever the switch says, so the button reads as off and offers to show.
  const on = props.layers?.networkOn === true && !needsVid
  const label = on
    ? t('flightMap.hideNetworkTraffic', { network: name })
    : t('flightMap.showNetworkTraffic', { network: name })
  return (
    <ToggleControl
      on={on}
      label={label}
      title={needsVid ? t('flightMap.networkTrafficNeedsVid') : label}
      onClick={props.onToggle}
      disabled={needsVid}
    >
      <Plane />
    </ToggleControl>
  )
}

/**
 * The shared switch for the sim's own traffic (BeyondATC's aircraft and any other AI traffic). While the network's traffic is drawn it is
 * disabled and says why, and it comes back as it was when the network layer goes off (the switch itself is not touched).
 *
 * @param props The layers (the switch's state and whether the network holds it back), the traffic (which network), and the toggle.
 * @returns The element.
 */
function SimTrafficButton(props: {
  layers: TrafficLayers | null
  traffic: NetworkTraffic | null
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const blocked = props.layers?.simBlockedByNetwork === true
  const on = props.layers?.simOn === true && !blocked
  const label = on ? t('flightMap.hideSimTraffic') : t('flightMap.showSimTraffic')
  const network = props.traffic?.network
  return (
    <ToggleControl
      on={on}
      label={label}
      title={
        blocked && network ? t('flightMap.simTrafficBlocked', { network: NETWORK_NAMES[network] }) : label
      }
      onClick={props.onToggle}
      disabled={blocked}
    >
      <PlaneTakeoff />
    </ToggleControl>
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
  /** The shared network-traffic switch's state; omitted (no button) on a map that is not live. */
  networkTraffic?: {
    layers: TrafficLayers | null
    traffic: NetworkTraffic | null
    onToggle: () => void
    onToggleSim: () => void
  }
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
      {props.live && props.networkTraffic && (
        <>
          <NetworkTrafficButton {...props.networkTraffic} />
          <SimTrafficButton
            layers={props.networkTraffic.layers}
            traffic={props.networkTraffic.traffic}
            onToggle={props.networkTraffic.onToggleSim}
          />
        </>
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
 * The VFR overlay's nearest-airfield pill, the first of the top-left pills.
 *
 * @param props The nearest airfield's text.
 * @returns The element.
 */
function NearestAirfieldPill(props: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className={`max-w-full truncate ${PILL_CLASS_NAME}`} aria-label={t('flightMap.nearestAirfield')}>
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
 * @param traffic The network traffic topic.
 * @returns The translation key of the pill to show, or null when there is nothing to say.
 */
function trafficProblemKey(traffic: NetworkTraffic | null | undefined): string | null {
  if (traffic?.state === 'unavailable') return 'flightMap.networkTrafficUnavailable'
  if (traffic?.state === 'noCentre') return 'flightMap.networkTrafficNoCentre'
  return null
}

/**
 * Says the sim's own traffic cannot be read, while the layer is meant to draw.
 *
 * @param props The layers and the sim traffic topic.
 * @returns The pill, or nothing.
 */
function SimTrafficPill(props: {
  layers?: TrafficLayers | null
  traffic?: SimTraffic | null
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (props.layers?.drawSim !== true || props.traffic?.state !== 'unavailable') return null
  return <div className={PILL_CLASS_NAME}>{t('flightMap.simTrafficUnavailable')}</div>
}

/**
 * The pills at the map's top left, one under another so they never cover each other: the nearest airfield (VFR overlay on), then why the
 * network's or the sim's traffic can't be shown.
 *
 * @param props Whether live, the VFR overlay's state, and the two traffic topics.
 * @returns The column, or nothing on a map that is not live.
 */
function TopLeftPills(props: {
  live: boolean
  vfr: { enabled: boolean; nearestText: string | null }
  traffic?: NetworkTraffic | null
  simTraffic?: { layers: TrafficLayers | null; traffic: SimTraffic | null }
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!props.live) return null
  const trafficProblem = trafficProblemKey(props.traffic)
  return (
    <div className="absolute top-3 left-3 flex max-w-[calc(100%-4.5rem)] flex-col items-start gap-1.5">
      {props.vfr.enabled && props.vfr.nearestText && <NearestAirfieldPill text={props.vfr.nearestText} />}
      {trafficProblem && props.traffic?.network && (
        <div className={PILL_CLASS_NAME}>
          {t(trafficProblem, { network: NETWORK_NAMES[props.traffic.network] })}
        </div>
      )}
      <SimTrafficPill {...props.simTraffic} />
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
  /** The network traffic's state, for the pill that says it cannot be shown. */
  traffic?: NetworkTraffic | null
  /** The sim traffic's state and the layers, for the pill that says the sim cannot be read. */
  simTraffic?: { layers: TrafficLayers | null; traffic: SimTraffic | null }
}): React.JSX.Element {
  const { t } = useTranslation()
  const { live, vfr, taxiChart } = props
  return (
    <>
      {live && (
        <TelemetryReadout telemetry={props.telemetry} phase={props.phase} transition={props.transition} />
      )}
      <TopLeftPills live={live} vfr={vfr} traffic={props.traffic} simTraffic={props.simTraffic} />
      {taxiChart.enabled && taxiChart.loadingIcao && <TaxiChartLoadingPill icao={taxiChart.loadingIcao} />}
      {props.routeIsApproximate && (
        <div className="absolute bottom-3 left-3 rounded-full border border-border bg-popover/85 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
          {t('flightMap.approximateRoute')}
        </div>
      )}
    </>
  )
}
