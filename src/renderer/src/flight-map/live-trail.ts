/**
 * The steps of Track's live trail: what the map does with the aircraft marker, the trail and the
 * camera when a new track point arrives. FlightMap's live-trail effect picks one per point.
 */

import type { GeoJSONSource, Map as MapLibreMap, Marker } from 'maplibre-gl'
import type { TrackPoint } from '@shared/ipc'
import { followBand, zoomForBand } from '../followZoom'
import { updateSourceData } from '../map-source'
import { uiMemory } from '../ui-memory'
import {
  lineString,
  multiLineString,
  trailSegments,
  TRAIL_SOURCE_ID,
  TRAIL_TIP_SOURCE_ID
} from './map-layers'

function trailSources(map: MapLibreMap): {
  source: GeoJSONSource | undefined
  tipSource: GeoJSONSource | undefined
} {
  return {
    source: map.getSource<GeoJSONSource>(TRAIL_SOURCE_ID),
    tipSource: map.getSource<GeoJSONSource>(TRAIL_TIP_SOURCE_ID)
  }
}

/**
 * No points to show (e.g. the flight was just cancelled, finished, or auto-completed) — clears
 * both trail sources and pulls the marker off the map rather than leaving the last-drawn
 * position stuck there indefinitely.
 *
 * @param map The map.
 * @param marker The aircraft marker, if built yet.
 */
export function clearLiveTrail(map: MapLibreMap, marker: Marker | null): void {
  const { source, tipSource } = trailSources(map)
  updateSourceData(source, lineString([]))
  updateSourceData(tipSource, lineString([]))
  if (marker?.getElement().isConnected) marker.remove()
}

/**
 * Draws the whole trail at once and puts the marker on the latest point, with no animation.
 *
 * @param map The map.
 * @param marker The aircraft marker.
 * @param trackPoints The visible track.
 */
function drawWholeTrail(map: MapLibreMap, marker: Marker, trackPoints: TrackPoint[]): void {
  const to = trackPoints[trackPoints.length - 1]
  const { source, tipSource } = trailSources(map)
  updateSourceData(source, multiLineString(trailSegments(trackPoints)))
  updateSourceData(tipSource, lineString([]))
  marker.setLngLat([to.longitude, to.latitude])
  marker.setRotation(to.headingTrueDeg)
}

/**
 * First point of this mount: jump in to something usable rather than sitting at whatever
 * center/zoom the map was constructed with. No animation for this one — it may be catching
 * up on a whole batch of history from a resumed in-progress flight, possibly spanning several
 * resume segments.
 *
 * @param map The map.
 * @param marker The aircraft marker, already on the map.
 * @param trackPoints The visible track, at least one point.
 * @param followEnabled Whether the camera follows the aircraft.
 * @param onFramed Called once the tiles at the aircraft are drawn, when following.
 */
export function showFirstPoint(
  map: MapLibreMap,
  marker: Marker,
  trackPoints: TrackPoint[],
  followEnabled: boolean,
  onFramed: () => void
): void {
  const to = trackPoints[trackPoints.length - 1]
  drawWholeTrail(map, marker, trackPoints)
  if (!followEnabled) return
  // A remount already restored the last camera via the constructor (uiMemory().liveCamera)
  // — its zoom is kept only if the user chose it, so coming back to Track doesn't re-clobber
  // a zoom they set, but a zoom the map picked itself (e.g. a route overview) never stands
  // in for the ground/altitude follow zoom.
  if (uiMemory().liveCamera && uiMemory().liveZoomChosenByUser)
    map.jumpTo({ center: [to.longitude, to.latitude] })
  else
    map.jumpTo({
      center: [to.longitude, to.latitude],
      zoom: zoomForBand(followBand(to, null))
    })
  // Show the map once the tiles at the aircraft are drawn, not before.
  map.once('idle', onFramed)
}

/**
 * No prior point in the same resume segment to animate the marker in from — commits the latest
 * point straight to the trail instead of drawing a tip line across the gap.
 *
 * @param map The map.
 * @param marker The aircraft marker, already on the map.
 * @param trackPoints The visible track, at least one point.
 * @param followEnabled Whether the camera follows the aircraft.
 */
export function jumpAcrossGap(
  map: MapLibreMap,
  marker: Marker,
  trackPoints: TrackPoint[],
  followEnabled: boolean
): void {
  const to = trackPoints[trackPoints.length - 1]
  drawWholeTrail(map, marker, trackPoints)
  if (followEnabled) map.easeTo({ center: [to.longitude, to.latitude], duration: 500 })
}

/**
 * Animates the marker, the trail's tip and (when following) the camera across the real gap
 * between the last two samples, rather than snapping — even at the tighter 2s/5s climb/cruise
 * recording intervals (see FlightRecorder.ts) a plain snap-to still reads as a jump.
 *
 * @param map The map.
 * @param markerRef The aircraft marker's ref, read every frame.
 * @param trackPoints The visible track, at least two points in the same resume segment at the end.
 * @param followEnabled Whether the camera follows the aircraft.
 * @returns Stops the animation.
 */
export function animateLatestLeg(
  map: MapLibreMap,
  markerRef: { current: Marker | null },
  trackPoints: TrackPoint[],
  followEnabled: boolean
): () => void {
  const to = trackPoints[trackPoints.length - 1]
  const from = trackPoints[trackPoints.length - 2]
  const { source, tipSource } = trailSources(map)
  // The committed trail is done for this sample — write it once, here, not per frame.
  // Everything except the still-animating final leg, so this payload never grows on the
  // frame's own cost.
  updateSourceData(source, multiLineString(trailSegments(trackPoints.slice(0, -1))))

  // Rotation shows the plane's actual nose heading (not the ground track the marker is
  // animating along) — the gap between the two through a turn or in a crosswind is
  // exactly the crab angle, which is useful to see. Interpolated smoothly between the
  // two reported samples, same as position — a snap-to-latest read as a visible jump in
  // rotation each time a new sample arrived, even though it's technically the more
  // "correct" instantaneous value.
  // Shortest-path delta so e.g. 350deg -> 10deg animates through 360, not backwards
  // through 180.
  const headingDelta = ((to.headingTrueDeg - from.headingTrueDeg + 540) % 360) - 180
  // Capped so a paused sim or a stale first sample can't produce a multi-minute crawl.
  const durationMs = Math.min(
    Math.max(new Date(to.tsUtc).getTime() - new Date(from.tsUtc).getTime(), 200),
    20000
  )
  const fromCoord: [number, number] = [from.longitude, from.latitude]
  const startTime = performance.now()
  let frame = requestAnimationFrame(function step(now) {
    const t = Math.min((now - startTime) / durationMs, 1)
    const lng = from.longitude + (to.longitude - from.longitude) * t
    const lat = from.latitude + (to.latitude - from.latitude) * t
    markerRef.current?.setLngLat([lng, lat])
    markerRef.current?.setRotation(from.headingTrueDeg + headingDelta * t)
    // Constant-size payload (2 points) every frame, regardless of flight length — this
    // is the only thing redrawn at animation rate; the long-lived trail above isn't.
    updateSourceData(tipSource, lineString([fromCoord, [lng, lat]]))
    if (t < 1) frame = requestAnimationFrame(step)
  })
  if (followEnabled) map.easeTo({ center: [to.longitude, to.latitude], duration: durationMs })

  return () => cancelAnimationFrame(frame)
}
