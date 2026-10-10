/** The map shared by Dispatch, Track and the Logbook: route, waypoints, track, aircraft and overlays. */

import { useMemo } from 'react'
import type { FlightPhase, MapLanguage, SimTelemetry, TrackPoint } from '@shared/ipc'
import { cn } from '@/lib/utils'
import type { TransitionAltitudes, Waypoint } from './route'
import { filterVisibleTrackPoints } from './track-point-visibility'
import { useTaxiChartOverlay } from './use-taxi-chart-overlay'
import { useTaxiRouteHighlight } from './use-taxi-route-highlight'
import { useVfrOverlay } from './use-vfr-overlay'
import { ROUTE_SOURCE_ID } from './flight-map/map-layers'
import { isMapVisible, taxiPosition } from './flight-map/map-state'
import { MapControls, MapPills } from './flight-map/MapOverlays'
import {
  useFollowToggle,
  useMapInstance,
  useMapInteraction,
  useRouteLayers,
  useTrailLayers
} from './flight-map/use-flight-map'

export interface FlightMapProps {
  /** Planned route (from the flight's stored OFP), GeoJSON [lon, lat] order. */
  route: [number, number][]
  /** Per-fix waypoint pins along the planned route (ident labels), same source as `route`. */
  waypoints?: Waypoint[]
  /** Every recorded point, unfiltered — points with a non-null `excludedReason` (junk from
   *  a crash-resume or a mid-flight teleport, winglog-backend's docs/plans/
   *  resume-track-cleanup.md) are dropped inside this component, not by the caller. */
  trackPoints: TrackPoint[]
  /**
   * true (TrackView): animated marker/camera follow as new points arrive.
   * false (Logbook detail): draw the whole trail once and fit the view to it — the
   * flight's over, there's nothing to follow, and seeing the full route at a glance is
   * more useful for review than a zoomed-in single point.
   */
  live: boolean
  /** Live sim telemetry — shown as a small IAS/altitude/heading overlay at the map's
   *  bottom edge when present (TrackView only; Logbook/Dispatch don't pass it). */
  telemetry?: SimTelemetry | null
  /** The active flight's current phase — decides whether the overlay's altitude reads
   *  pressure or true altitude (docs/plans/logbook-detail-improvements.md, Phase 3; see
   *  display-altitude.ts). Only meaningful alongside `telemetry`; ignored otherwise. */
  telemetryPhase?: FlightPhase
  /** The flight's OFP transition altitude/level, for the same overlay calculation — null
   *  falls back to a fixed 18,000 ft (see display-altitude.ts). */
  telemetryTransition?: TransitionAltitudes | null
  /** True when `route` is a synthesized great-circle line (docs/plans/
   *  great-circle-fallback-route.md), not a real SimBrief-derived route — styled more
   *  faintly, with a caption, so it can't be mistaken for a genuine planned route. */
  routeIsApproximate?: boolean
  /** Language of the base map's place names (Settings → UI → Map language). Defaults to
   *  English. Applied to the hosted style's own labels — see map-labels.ts. */
  mapLanguage?: MapLanguage
  /** Departure/arrival ICAOs, for the taxi chart overlay (winglog-backend's docs/plans/
   *  taxi-network-overlay.md) — null/omitted when unknown (e.g. a free flight). Available in
   *  both live and replay, unlike the VFR overlay, since it's static reference data with no
   *  "now" to depend on. */
  depIcao?: string | null
  arrIcao?: string | null
  /** Live only: the active flight's recorded track is still loading. The route isn't framed
   *  meanwhile — with follow on, the aircraft is about to be, and framing the route first
   *  flashed it before jumping to the aircraft on every visit to Track. */
  trackLoading?: boolean
}

// Stable reference for the default so the route/waypoint effect doesn't re-fire on
// every render just because callers that don't pass `waypoints` get a fresh `[]` each time.
const EMPTY_WAYPOINTS: Waypoint[] = []

/**
 * The flight map.
 *
 * @param props The route, waypoints and track; whether it's live, with its telemetry; the map language; and the flight's airports.
 * @returns The element.
 */
export function FlightMap({
  route,
  waypoints = EMPTY_WAYPOINTS,
  trackPoints: rawTrackPoints,
  live,
  telemetry,
  telemetryPhase: activePhase,
  telemetryTransition = null,
  routeIsApproximate = false,
  mapLanguage = 'en',
  depIcao = null,
  arrIcao = null,
  trackLoading = false
}: FlightMapProps): React.JSX.Element {
  // Points a resume-track-cleanup pass has flagged as junk (winglog-backend's docs/
  // plans/resume-track-cleanup.md) never get drawn — filtered once here rather than in
  // each effect, so every index-based lookup (last point, [-2] for the animation's
  // "from", trailSegments' own iteration) already only ever sees the real trail.
  const trackPoints = useMemo(() => filterVisibleTrackPoints(rawTrackPoints), [rawTrackPoints])
  const hasAircraft = trackPoints.length > 0
  const { followEnabled, setFollowEnabled, followingAircraftRef } = useFollowToggle(live, hasAircraft)
  const instance = useMapInstance(live, mapLanguage)
  const { mapContainerRef, mapRef, mapReady, framed } = instance
  useRouteLayers(instance, {
    route,
    waypoints,
    live,
    trackLoading,
    followingAircraftRef,
    mapLanguage,
    routeIsApproximate
  })
  useTrailLayers(instance, { trackPoints, route, live, followEnabled })
  useMapInteraction(instance, live, followEnabled, hasAircraft)

  const vfr = useVfrOverlay({
    mapRef,
    mapReady,
    live,
    telemetry,
    trackPoints,
    routeLayerId: ROUTE_SOURCE_ID
  })

  const taxiChart = useTaxiChartOverlay({ mapRef, mapReady, depIcao, arrIcao })
  useTaxiRouteHighlight({
    mapRef,
    mapReady,
    enabled: taxiChart.enabled,
    segmentsByIcao: taxiChart.segmentsByIcao,
    depIcao,
    arrIcao,
    position: taxiPosition(telemetry),
    phase: activePhase ?? null
  })

  const mapVisible = isMapVisible({ live, framed, followEnabled, trackLoading, hasAircraft })

  return (
    <div className="relative h-full">
      <div
        ref={mapContainerRef}
        data-framed={mapVisible}
        className={cn(
          'h-full min-h-64 w-full overflow-hidden rounded-xl border border-border transition-opacity duration-150',
          !mapVisible && 'opacity-0'
        )}
      />
      <MapControls
        live={live}
        followEnabled={followEnabled}
        onToggleFollow={() => setFollowEnabled((v) => !v)}
        vfrEnabled={vfr.enabled}
        onToggleVfr={vfr.toggle}
        taxiChartEnabled={taxiChart.enabled}
        onToggleTaxiChart={taxiChart.toggle}
        onZoomIn={() => mapRef.current?.zoomIn()}
        onZoomOut={() => mapRef.current?.zoomOut()}
      />
      <MapPills
        live={live}
        telemetry={telemetry}
        phase={activePhase}
        transition={telemetryTransition}
        vfr={vfr}
        taxiChart={taxiChart}
        routeIsApproximate={routeIsApproximate}
      />
    </div>
  )
}
