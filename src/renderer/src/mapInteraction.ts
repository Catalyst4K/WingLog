/** Which MapLibre interaction handlers should be active on `FlightMap`'s map, and how.
 *  `scrollZoom`/`touchZoomRotate` are never turned off outright — only re-anchored — so
 *  `true` means "MapLibre's own default" and `{ around: 'center' }` means "re-enable
 *  anchored to the map's center" (see `ScrollZoomHandler.enable`'s `AroundCenterOptions`
 *  in maplibre-gl's own types). */
export interface MapInteractionConfig {
  /** Free-drag panning. */
  dragPan: boolean
  /** Arrow-key panning (and +/- zoom, which isn't affected either way). */
  keyboard: boolean
  scrollZoom: boolean | { around: 'center' }
  touchZoomRotate: boolean | { around: 'center' }
  /** Zooms toward wherever was double-clicked/double-tapped — there's no "anchor to
   *  center" variant of this one, so it's just off while locked. */
  doubleClickZoom: boolean
}

/**
 * Decides which pan/zoom handlers should be active, given the three facts that matter
 * (docs/plans/map-controls.md):
 *
 * - `live`: is this the live-tracking map at all (false for Logbook's static per-flight
 *   map, which always gets MapLibre's defaults — there's nothing to follow or lock).
 * - `followEnabled`: is the camera-follow toggle on.
 * - `hasAircraft`: is there actually a track point to follow yet. Track's map is also
 *   `live` before any track points exist (previewing a planned flight before it starts),
 *   and `followEnabled` defaults on — locking panning keyed only on those two would freeze
 *   that empty preview, with nothing on the map yet to turn follow off *for*.
 *
 * Panning is locked only when all three hold. Scroll/pinch zoom are left enabled in every
 * case — the plan deliberately keeps zoom under the user's control while following — but
 * re-anchored to the map's center while locked, so zooming can't drag the view off the
 * aircraft the way anchoring to the cursor/pinch point would.
 */
export function mapInteraction(
  live: boolean,
  followEnabled: boolean,
  hasAircraft: boolean
): MapInteractionConfig {
  const locked = live && followEnabled && hasAircraft
  return {
    dragPan: !locked,
    keyboard: !locked,
    scrollZoom: locked ? { around: 'center' } : true,
    touchZoomRotate: locked ? { around: 'center' } : true,
    doubleClickZoom: !locked
  }
}
