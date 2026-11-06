/**
 * Recolours OpenFreeMap's hosted `positron` and `dark` base styles to the paper and ink palette (winglog-backend docs/plans/v2-design.md,
 * "The map", spike S1): same tiles, our colours, applied once the style has loaded. Both styles are already close to greyscale, so only
 * the ground, the water (blue), the parks and woods (green), the land-use areas and the place and water labels change; roads, buildings and the airport layers stay as the
 * style draws them. Best-effort like `applyLabelStyle`: it is a third-party style with no version pin, so a missing layer or a changed
 * shape leaves that layer, or the whole map, as the style drew it.
 */
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { StyleLayerLike } from '../map-labels'
import { mapPalette, type MapPalette } from './map-palette'

const WATER_FILL = /^water$/
const GREEN_FILL = /^(park|landcover_(wood|grass))/
const LAND_USE_FILL = /^(landcover_(?!ice)|landuse_)/

/**
 * @param layer One layer of the style.
 * @param palette The map's colours.
 * @returns The paint properties to set on it, or none when the layer is left as the style drew it.
 */
function paintFor(layer: StyleLayerLike, palette: MapPalette): Record<string, string> {
  if (layer.type === 'background') return { 'background-color': palette.land }
  if (layer.type === 'fill' && WATER_FILL.test(layer.id)) return { 'fill-color': palette.sea }
  if (layer.type === 'fill' && GREEN_FILL.test(layer.id)) return { 'fill-color': palette.green }
  if (layer.type === 'fill' && LAND_USE_FILL.test(layer.id)) return { 'fill-color': palette.area }
  if (layer.type === 'line' && layer.id === 'waterway') return { 'line-color': palette.sea }
  if (layer.type === 'symbol' && layer.layout?.['text-field'] !== undefined)
    return { 'text-color': palette.quiet, 'text-halo-color': palette.halo }
  return {}
}

/**
 * @param map The map, its style loaded.
 * @param dark Whether the dark theme is on.
 */
export function recolourBasemap(map: MapLibreMap, dark: boolean): void {
  const palette = mapPalette(dark)
  let layers: StyleLayerLike[]
  try {
    layers = map.getStyle().layers as StyleLayerLike[]
  } catch {
    return
  }
  for (const layer of layers) {
    try {
      for (const [property, colour] of Object.entries(paintFor(layer, palette)))
        map.setPaintProperty(layer.id, property as never, colour as never)
    } catch {
      // Leave this layer as the style drew it.
    }
  }
}
