/**
 * FlightMap's state and effects: the map instance itself, the follow toggle, the planned route,
 * the flown trail and the pan/zoom lock. FlightMap calls these in this order, which is the
 * order its effects ran in before they were split out.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { GeoJSONSource, Map as MapLibreMap, Marker } from 'maplibre-gl'
import type { MapLanguage, TrackPoint } from '@shared/ipc'
import { followBand, zoomForBand, type FollowBand } from '../followZoom'
import { mapInteraction } from '../mapInteraction'
import { updateSourceData } from '../map-source'
import { runAsync } from '../report-error'
import type { Waypoint } from '../route'
import { uiMemory } from '../ui-memory'
import { animateLatestLeg, clearLiveTrail, jumpAcrossGap, showFirstPoint } from './live-trail'
import {
  addFlightLayers,
  applyLabelStyle,
  createFlightMap,
  ensureWorkerReady,
  fitBoundsTo,
  isDarkTheme,
  lineString,
  multiLineString,
  routeKey,
  ROUTE_APPROXIMATE_LAYER_ID,
  ROUTE_SOURCE_ID,
  trailSegments,
  TRAIL_SOURCE_ID,
  waypointFeatures,
  WAYPOINT_SOURCE_ID
} from './map-layers'

// How long Track's map may stay hidden waiting to frame the aircraft before it's shown
// anyway (see `framed` below).
const FRAME_REVEAL_FALLBACK_MS = 1500

/**
 * Whether the camera keeps recentering on the aircraft as new track points arrive (live mode
 * only) — a user panning around to look at something shouldn't keep getting yanked back.
 * Defaults on, matching the always-follow behavior before this was made toggleable; the live
 * map remembers it across remounts.
 *
 * @param live Whether this is Track's live map.
 * @param hasAircraft Whether there's a track to follow.
 * @returns The toggle, its setter, and a ref saying whether the aircraft is being followed now.
 */
export function useFollowToggle(
  live: boolean,
  hasAircraft: boolean
): {
  followEnabled: boolean
  setFollowEnabled: React.Dispatch<React.SetStateAction<boolean>>
  followingAircraftRef: RefObject<boolean>
} {
  const [followEnabled, setFollowEnabled] = useState(() => (live ? uiMemory().followEnabled : true))
  useEffect(() => {
    if (live) uiMemory().followEnabled = followEnabled
  }, [live, followEnabled])
  // Read (not depended on) by the route-fit effect, so a new track point never re-runs the fit.
  // Kept current by an effect rather than during render; FlightMap calls this hook before
  // useRouteLayers, so it's updated before that effect reads it in the same commit.
  const followingAircraftRef = useRef(false)
  useEffect(() => {
    followingAircraftRef.current = followEnabled && hasAircraft
  })
  return { followEnabled, setFollowEnabled, followingAircraftRef }
}

/** The map instance and what the rest of FlightMap needs to reach it. */
export interface MapInstance {
  mapContainerRef: RefObject<HTMLDivElement | null>
  mapRef: RefObject<MapLibreMap | null>
  markerRef: RefObject<Marker | null>
  /** Whether the live map has framed something real since this mount. Not trackPoints.length
   *  === 1: resuming an in-progress flight loads every existing point in one batch
   *  (trackPointList), so length would jump straight past 1. */
  hasCenteredRef: RefObject<boolean>
  /** True once the style has loaded and the map's own sources and layers exist. */
  mapReady: boolean
  /** Whether Track's map has framed the aircraft (or given up waiting). */
  framed: boolean
  setFramed: (framed: boolean) => void
}

/**
 * Creates the map — once per mount. Data is pushed in by the other hooks as it changes. Gated
 * on ensureWorkerReady() so the worker's blob: URL is registered (setWorkerUrl) before
 * MapLibreMap's constructor ever spawns the worker that needs it.
 *
 * @param live Whether this is Track's live map. Never changes across one instance's lifetime.
 * @param mapLanguage The base map's label language.
 * @returns The map instance.
 */
export function useMapInstance(live: boolean, mapLanguage: MapLanguage): MapInstance {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const hasCenteredRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)
  // Track's map stays invisible until it has framed the aircraft, so coming back to Track
  // doesn't show the remembered (by now stale) view and then jump to where the aircraft is
  // now (Callum, 2026-10-02: "a second of stutter / tiny jump around as it loads").
  const [framed, setFramed] = useState(false)
  // Read by the 'style.load' handler, which is registered once at map creation — a ref so
  // it always sees the current language rather than the one from the first render.
  const mapLanguageRef = useRef(mapLanguage)
  useEffect(() => {
    mapLanguageRef.current = mapLanguage
  })

  useEffect(() => {
    /* v8 ignore start -- React attaches a ref before running passive effects, and the
     * container div is always rendered unconditionally, so this branch can't actually be
     * reached on any real mount; defensive only. */
    if (!mapContainerRef.current) return
    /* v8 ignore stop */
    let cancelled = false

    runAsync(
      'FlightMap only',
      ensureWorkerReady().then(() => {
        // `cancelled` is reachable in principle (a fast unmount before the worker's blob:
        // fetch resolves) but not exercised here — not worth the timing-fiddly test setup
        // that'd need. `!mapContainerRef.current` alongside it is defensive, same as above.
        /* v8 ignore start */
        if (cancelled || !mapContainerRef.current) return
        /* v8 ignore stop */
        const dark = isDarkTheme()
        const map = createFlightMap(mapContainerRef.current, live, dark)
        mapRef.current = map

        // 'load' waits for every tile in the current viewport to finish rendering — at this
        // initial [0,0]/zoom 1 (whole-world) view that can take a very long time or never
        // fully fire. 'style.load' fires once the style itself is parsed, which is all that's
        // needed to safely add sources/layers (sim-confirmed: 'load' never fired within 10s
        // in manual testing here, 'style.load' fires almost immediately).
        map.on('style.load', () => {
          // A theme switch reloads the style and drops these, so re-apply on every load.
          applyLabelStyle(map, mapLanguageRef.current)
          markerRef.current = addFlightLayers(map, dark)
          setMapReady(true)
        })
      })
    )

    // A safety net: never leave the map hidden if the aircraft can't be framed for some
    // reason (no idle event, a slow track load).
    const revealTimer = setTimeout(() => setFramed(true), FRAME_REVEAL_FALLBACK_MS)

    return () => {
      cancelled = true
      clearTimeout(revealTimer)
      // Leaving Track mid-pan (follow mode is nearly always partway through an easeTo in the
      // air) would otherwise leave uiMemory().liveCamera at the last *finished* move, seconds
      // behind. Only once the map has framed something real, never the constructor default.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- a flag, not a DOM node: the value at unmount is the one wanted
      if (live && mapRef.current && hasCenteredRef.current) {
        uiMemory().liveCamera = {
          center: mapRef.current.getCenter().toArray() as [number, number],
          zoom: mapRef.current.getZoom()
        }
      }
      mapRef.current?.remove()
      mapRef.current = null
      markerRef.current = null
    }
    // Map construction must run exactly once per mount, not on every `live` change — in
    // practice a given FlightMap instance's `live` prop never actually changes across its
    // own lifetime (TrackView and LogbookView each always pass one fixed value), so
    // there's no real remount behavior being traded away here, just an intentionally
    // narrow effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the map is created once per instance
  }, [])

  return { mapContainerRef, mapRef, markerRef, hasCenteredRef, mapReady, framed, setFramed }
}

/**
 * Draws the planned route and its waypoint pins (nothing, for a flight with no stored OFP),
 * frames the live map on the route, keeps the base map's labels in the chosen language, and
 * switches between the real and the approximate route's styling.
 *
 * @param instance The map instance.
 * @param options The route and waypoints; whether live, still loading the track, and following
 *   the aircraft; the label language; and whether the route is approximate.
 */
export function useRouteLayers(
  instance: MapInstance,
  options: {
    route: [number, number][]
    waypoints: Waypoint[]
    live: boolean
    trackLoading: boolean
    followingAircraftRef: RefObject<boolean>
    mapLanguage: MapLanguage
    routeIsApproximate: boolean
  }
): void {
  const { mapRef, mapReady } = instance
  const { route, waypoints, live, trackLoading, followingAircraftRef, mapLanguage, routeIsApproximate } =
    options

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const routeSource = mapRef.current.getSource<GeoJSONSource>(ROUTE_SOURCE_ID)
    updateSourceData(routeSource, lineString(route))
    const waypointSource = mapRef.current.getSource<GeoJSONSource>(WAYPOINT_SOURCE_ID)
    updateSourceData(waypointSource, waypointFeatures(waypoints))
    if (!live || trackLoading) return
    // Same route as the remembered camera was framed for: keep the user's own view.
    const key = routeKey(route)
    if (uiMemory().liveCamera && uiMemory().liveCameraRouteKey === key) return
    uiMemory().liveCameraRouteKey = key
    // Following an aircraft: the follow effect frames it instead — fitting the whole route
    // first would just be overwritten (and flash) a moment later.
    if (!followingAircraftRef.current) fitBoundsTo(mapRef.current, route)
  }, [mapReady, route, waypoints, live, trackLoading, mapRef, followingAircraftRef])

  // A language change while the map is open (only possible from a remount today, since
  // Settings is its own tab, but cheap to keep correct) re-applies to the loaded style.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    applyLabelStyle(mapRef.current, mapLanguage)
  }, [mapReady, mapLanguage, mapRef])

  // Switches which of the two route layers is visible — set via setLayoutProperty rather
  // than baked in at creation, since Logbook resolves the fallback asynchronously after the
  // map's one-time setup effect has already run (a real route is known synchronously and
  // never needs this to change).
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const map = mapRef.current
    map.setLayoutProperty(ROUTE_SOURCE_ID, 'visibility', routeIsApproximate ? 'none' : 'visible')
    map.setLayoutProperty(ROUTE_APPROXIMATE_LAYER_ID, 'visibility', routeIsApproximate ? 'visible' : 'none')
  }, [mapReady, routeIsApproximate, mapRef])
}

/**
 * Draws the flown trail and the aircraft marker. Logbook's static map draws the whole trail
 * once and fits the view to it; Track's live map follows each new point (live-trail.ts),
 * steps the follow zoom at takeoff, touchdown and altitude band changes, and recentres when
 * follow is switched back on.
 *
 * @param instance The map instance.
 * @param options The visible track, the planned route, whether live, and whether following.
 */
export function useTrailLayers(
  instance: MapInstance,
  options: { trackPoints: TrackPoint[]; route: [number, number][]; live: boolean; followEnabled: boolean }
): void {
  const { mapRef, markerRef, hasCenteredRef, mapReady, setFramed } = instance
  const { trackPoints, route, live, followEnabled } = options

  // Static (Logbook) mode: draw the whole trail once and fit the view to it. No follow,
  // no animation — the flight already happened.
  useEffect(() => {
    if (!mapReady || !mapRef.current || live) return
    const coords: [number, number][] = trackPoints.map((p) => [p.longitude, p.latitude])
    const source = mapRef.current.getSource<GeoJSONSource>(TRAIL_SOURCE_ID)
    updateSourceData(source, multiLineString(trailSegments(trackPoints)))

    const last = trackPoints[trackPoints.length - 1]
    if (last && markerRef.current) {
      markerRef.current.setLngLat([last.longitude, last.latitude])
      markerRef.current.setRotation(last.headingTrueDeg)
      if (!markerRef.current.getElement().isConnected) markerRef.current.addTo(mapRef.current)
    }
    // No flown trail to fit to yet (e.g. Dispatch's fetched-but-not-flown OFP preview) —
    // fall back to the planned route so the map still zooms to something useful instead
    // of sitting at the whole-world default view.
    fitBoundsTo(mapRef.current, coords.length > 0 ? coords : route)
  }, [mapReady, trackPoints, route, live, mapRef, markerRef])

  // Live (TrackView) mode: trail + marker follow the accumulated track points.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !live) return
    const map = mapRef.current
    const to = trackPoints[trackPoints.length - 1]
    if (!to) {
      clearLiveTrail(map, markerRef.current)
      hasCenteredRef.current = false
      return
    }
    /* v8 ignore start -- markerRef.current is always set before mapReady flips true (end of
     * the 'style.load' handler), and this effect's own guard already requires mapReady —
     * defensive only, not reachable via any path that gets this far. */
    if (!markerRef.current) return
    /* v8 ignore stop */
    const marker = markerRef.current
    if (!marker.getElement().isConnected) {
      // Marker.addTo() reads the marker's position immediately, so it must already have
      // one — attach it here, before any of the steps below, all of which assume the
      // marker is already on the map.
      marker.setLngLat([to.longitude, to.latitude])
      marker.addTo(map)
    }

    if (!hasCenteredRef.current) {
      hasCenteredRef.current = true
      showFirstPoint(map, marker, trackPoints, followEnabled, () => setFramed(true))
      return
    }

    const from = trackPoints[trackPoints.length - 2]
    // No prior point at all, or `to` starts a new resume segment — either way there's
    // nothing in the same segment to animate the marker in from.
    if (!from || from.resumeSegment !== to.resumeSegment) {
      jumpAcrossGap(map, marker, trackPoints, followEnabled)
      return
    }
    return animateLatestLeg(map, markerRef, trackPoints, followEnabled)
  }, [mapReady, trackPoints, live, followEnabled, mapRef, markerRef, hasCenteredRef, setFramed])

  // Takeoff, touchdown and altitude bands, while following: step the zoom out for the climb
  // and back in for the descent and taxi (Callum, 2026-09-30; by altitude 2026-10-02) — once
  // per band change, so a zoom the user sets in between is left alone until the next one.
  const lastPoint = trackPoints.at(-1) ?? null
  const followBandRef = useRef<FollowBand | null>(null)
  useEffect(() => {
    const previous = followBandRef.current
    const next = lastPoint ? followBand(lastPoint, previous) : null
    followBandRef.current = next
    if (!mapReady || !mapRef.current || !live || !followEnabled) return
    if (previous === null || next === null || previous === next) return
    mapRef.current.easeTo({ zoom: zoomForBand(next), duration: 1000 })
    // Only on a band change itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a band change
  }, [lastPoint])

  // Re-center immediately when follow is switched back on, rather than waiting for the
  // next track point to arrive.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !live || !followEnabled) return
    const last = trackPoints[trackPoints.length - 1]
    if (last) mapRef.current.easeTo({ center: [last.longitude, last.latitude], duration: 500 })
    // Only on the follow-enabled transition itself — trackPoints already has its own
    // effect above driving the camera while following.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when follow is switched on
  }, [followEnabled])
}

/**
 * Locks panning while genuinely following (live + follow on + an aircraft to follow), and
 * re-anchors zoom to the map's center while locked so it can't drag the view off the
 * aircraft. Reapplied whenever any of the three inputs change; Logbook's static map and a
 * not-yet-following live map always land back on MapLibre's own defaults.
 *
 * @param instance The map instance.
 * @param live Whether this is Track's live map.
 * @param followEnabled Whether follow is on.
 * @param hasAircraft Whether there's a track to follow — Track's map is also `live` before any
 *   track points exist (previewing a planned flight), and that empty preview mustn't freeze
 *   (docs/plans/map-controls.md).
 */
export function useMapInteraction(
  instance: MapInstance,
  live: boolean,
  followEnabled: boolean,
  hasAircraft: boolean
): void {
  const { mapRef, mapContainerRef, mapReady } = instance
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const map = mapRef.current
    const config = mapInteraction(live, followEnabled, hasAircraft)

    if (config.dragPan) map.dragPan.enable()
    else map.dragPan.disable()

    if (config.keyboard) map.keyboard.enable()
    else map.keyboard.disable()

    // Live-verified 2026-09-13 (map-controls.md's own "needs a live tracking session" item):
    // `ScrollZoomHandler.enable(options)` — and `TouchZoomRotateHandler`'s own pinch-zoom
    // handler underneath it — early-return with NO effect if the handler `isEnabled()`
    // already, which it always is here (MapLibre auto-enables both at map construction).
    // So calling `.enable({ around: 'center' })` on its own, as this did before, silently
    // never applied while locked — zooming while following kept anchoring to the cursor and
    // dragging the view off the aircraft instead of staying centered. `.disable()` first
    // forces the next `.enable()` to actually re-apply `around`.
    map.scrollZoom.disable()
    map.scrollZoom.enable(config.scrollZoom === true ? undefined : config.scrollZoom)
    map.touchZoomRotate.disable()
    map.touchZoomRotate.enable(config.touchZoomRotate === true ? undefined : config.touchZoomRotate)

    if (config.doubleClickZoom) map.doubleClickZoom.enable()
    else map.doubleClickZoom.disable()

    // MapLibre's grab-hand cursor comes from a CSS class keyed on the map's general
    // `interactive` option (maplibre-gl.css's `.maplibregl-interactive` rule), not on
    // individual handler state — disabling dragPan alone leaves the grab hand showing.
    // This class, scoped under our own container and listed in index.css with enough
    // specificity to win over maplibre's own rule regardless of stylesheet order, forces
    // the cursor back to default while panning is locked.
    mapContainerRef.current?.classList.toggle('map-pan-locked', !config.dragPan)
  }, [mapReady, live, followEnabled, hasAircraft, mapRef, mapContainerRef])
}
