import type { MapLanguage } from '@shared/ipc'

/**
 * Tidies and localises the hosted OpenFreeMap base style's own place-name labels
 * (flightdeck-backend docs/plans/map-language-and-declutter.md, Parts A and B1).
 *
 * Spike 2026-09-18 (both `positron` and `dark` styles fetched and read): every name label in
 * both styles — places, water, airports, road names — uses one `text-field` expression that
 * stacks `name:latin` and `name:nonlatin` on two lines whenever a non-Latin name exists,
 * which is the multi-language clutter. Place layers are the ones with `source-layer:
 * 'place'`; positron gives them minzooms, dark gives none.
 *
 * This module is *pure*: it plans changes from a style's layer list and FlightMap applies
 * them with `setLayoutProperty`/`setLayerZoomRange` on every `style.load` (a theme switch
 * reloads the style and drops them). Layers are matched by what they *are* (source-layer,
 * filter, the recognisable two-line expression), never by id, and anything that doesn't
 * look as expected is left alone — it's a third-party hosted style with no version pin.
 */

export const MAP_LANGUAGES: readonly { value: MapLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'local', label: 'Local' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italiano' },
  { value: 'ru', label: 'Русский' }
]

/** A single-line `text-field` for the language: the wanted `name:xx`, then progressively
 *  less specific names, so a feature with no translation still gets *a* label. */
export function labelExpression(language: MapLanguage): unknown[] {
  switch (language) {
    case 'local':
      return ['coalesce', ['get', 'name'], ['get', 'name:latin']]
    case 'en':
      return ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']]
    case 'ru':
      // A Russian reader prefers the local (often Cyrillic) name over a Latin transliteration.
      return ['coalesce', ['get', 'name:ru'], ['get', 'name'], ['get', 'name:latin']]
    default:
      return ['coalesce', ['get', `name:${language}`], ['get', 'name:latin'], ['get', 'name']]
  }
}

/** Minimal structural view of a style layer — what `map.getStyle().layers` provides. */
export interface StyleLayerLike {
  id: string
  type: string
  'source-layer'?: string
  filter?: unknown
  minzoom?: number
  maxzoom?: number
  layout?: Record<string, unknown>
}

export interface LayerChange {
  id: string
  textField?: unknown[]
  minzoom?: number
}

/** Zoom each low-value place class first appears at — one or two levels later than the
 *  styles' own, per "doesn't need too much reduction" (Callum, 2026-09-18). "other" is the
 *  catch-all bucket a style builds by *excluding* the major classes. */
const LOW_VALUE_MIN_ZOOM: Record<string, number> = {
  village: 10,
  hamlet: 12,
  suburb: 13,
  neighbourhood: 13,
  quarter: 13,
  isolated_dwelling: 13,
  state: 6,
  other: 10
}

const isGetClass = (expr: unknown): boolean => Array.isArray(expr) && expr[0] === 'get' && expr[1] === 'class'

/** The place classes a layer's filter selects: `include` for "class is one of", `exclude`
 *  for the "everything except" form (`match … false, true`). Only the shapes seen in the two
 *  real styles are understood; anything else yields nothing and the layer is left alone. */
function classesSelected(filter: unknown): { include: string[] | null; exclude: string[] | null } {
  const result: { include: string[] | null; exclude: string[] | null } = { include: null, exclude: null }
  const walk = (expr: unknown): void => {
    if (!Array.isArray(expr)) return
    if (expr[0] === '==' && isGetClass(expr[1]) && typeof expr[2] === 'string') {
      result.include = [...(result.include ?? []), expr[2]]
    } else if (expr[0] === 'match' && isGetClass(expr[1]) && Array.isArray(expr[2])) {
      const classes = expr[2].filter((c): c is string => typeof c === 'string')
      if (expr[3] === true) result.include = [...(result.include ?? []), ...classes]
      else if (expr[3] === false && expr[4] === true) result.exclude = [...(result.exclude ?? []), ...classes]
    } else if (expr[0] === 'all') {
      expr.slice(1).forEach(walk)
    }
  }
  walk(filter)
  return result
}

/** The zoom a place layer should not appear before, or null if it isn't a low-value layer
 *  (cities, towns, countries and continents are never touched). */
function lowValueFloor(layer: StyleLayerLike): number | null {
  const { include, exclude } = classesSelected(layer.filter)
  if (include && include.length > 0) {
    const floors = include.map((c) => LOW_VALUE_MIN_ZOOM[c])
    return floors.every((f) => f !== undefined) ? Math.max(...(floors as number[])) : null
  }
  if (exclude && exclude.length > 0) return LOW_VALUE_MIN_ZOOM['other'] ?? null
  return null
}

const hasTwoLineName = (layer: StyleLayerLike): boolean =>
  layer.type === 'symbol' && JSON.stringify(layer.layout?.['text-field'] ?? null).includes('"name:nonlatin"')

export function planStyleChanges(layers: StyleLayerLike[], language: MapLanguage): LayerChange[] {
  const changes: LayerChange[] = []
  for (const layer of layers) {
    if (layer.type !== 'symbol') continue
    const change: LayerChange = { id: layer.id }
    if (hasTwoLineName(layer)) change.textField = labelExpression(language)

    if (layer['source-layer'] === 'place') {
      const floor = lowValueFloor(layer)
      const current = layer.minzoom ?? 0
      // Never raise a layer's minzoom to (or past) its own maxzoom — that would hide it
      // entirely rather than declutter it.
      if (floor !== null && floor > current && (layer.maxzoom === undefined || floor < layer.maxzoom)) {
        change.minzoom = floor
      }
    }
    if (change.textField !== undefined || change.minzoom !== undefined) changes.push(change)
  }
  return changes
}
