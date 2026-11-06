/**
 * Recolours OpenFreeMap's hosted `positron` and `dark` base styles to the paper and ink palette (winglog-backend docs/plans/v2-design.md,
 * "The map", spike S1): same tiles, our colours, applied once the style has loaded. Both styles are already close to greyscale, so only
 * the ground, the water, the land-use areas and the place and water labels change; roads, buildings and the airport layers stay as the
 * style draws them. Best-effort like `applyLabelStyle`: it is a third-party style with no version pin, so a missing layer or a changed
 * shape leaves that layer, or the whole map, as the style drew it.
 */
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { StyleLayerLike } from '../map-labels'
import { mapPalette } from './map-palette'

const WATER_FILL = /^water$/
const LAND_USE_FILL = /^(park|landcover_(?!ice)|landuse_)/

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
      if (layer.type === 'background') {
        map.setPaintProperty(layer.id, 'background-color', palette.land)
      } else if (layer.type === 'fill' && WATER_FILL.test(layer.id)) {
        map.setPaintProperty(layer.id, 'fill-color', palette.sea)
      } else if (layer.type === 'fill' && LAND_USE_FILL.test(layer.id)) {
        map.setPaintProperty(layer.id, 'fill-color', palette.area)
      } else if (layer.type === 'line' && layer.id === 'waterway') {
        map.setPaintProperty(layer.id, 'line-color', palette.sea)
      } else if (layer.type === 'symbol' && layer.layout?.['text-field'] !== undefined) {
        map.setPaintProperty(layer.id, 'text-color', palette.quiet)
        map.setPaintProperty(layer.id, 'text-halo-color', palette.halo)
      }
    } catch {
      // Leave this layer as the style drew it.
    }
  }
}
