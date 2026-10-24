/**
 * The icon every traffic aircraft is drawn with: the own-aircraft outline in white on transparent, added to the map once as an SDF image
 * so one icon takes any colour (the network's amber, the sim's teal) from the layer's `icon-color`.
 */
import type { Map as MapLibreMap } from 'maplibre-gl'
import { AIRCRAFT_PATH_D } from './map-layers'

/** The icon's name in the map's style. */
export const TRAFFIC_ICON_ID = 'traffic-aircraft'

/** The icon's size in screen pixels; it is drawn at twice this and added with a pixel ratio of 2 so it stays sharp. */
const ICON_SIZE_PX = 24
const ICON_PIXEL_RATIO = 2

/**
 * Adds the traffic icon to the map unless it is there already.
 *
 * @param map The map.
 */
export function addTrafficIcon(map: MapLibreMap): void {
  if (map.hasImage(TRAFFIC_ICON_ID)) return
  const side = ICON_SIZE_PX * ICON_PIXEL_RATIO
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const context = canvas.getContext('2d')
  // No 2D canvas (a test environment): the layers still exist, they just have no picture.
  if (!context) return
  context.scale(ICON_PIXEL_RATIO, ICON_PIXEL_RATIO)
  context.fillStyle = '#ffffff'
  context.fill(new Path2D(AIRCRAFT_PATH_D))
  map.addImage(TRAFFIC_ICON_ID, context.getImageData(0, 0, side, side), {
    sdf: true,
    pixelRatio: ICON_PIXEL_RATIO
  })
}
