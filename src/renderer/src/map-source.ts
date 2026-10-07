/** Updating a map's GeoJSON sources without leaving MapLibre's promise floating. */

import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { diagMap } from './diag'

/** What a GeoJSON source takes: GeoJSON, or a URL to it. */
type SourceData = Parameters<GeoJSONSource['setData']>[0]

/**
 * Replaces a GeoJSON source's data, when the map has that source. MapLibre's `setData`
 * resolves once its worker has the data, and only rejects when the map is being torn down or
 * the worker failed. The next update replaces the data anyway, so a failure is noted in
 * diag.log (dev builds) and otherwise dropped.
 *
 * @param map The map.
 * @param sourceId The GeoJSON source.
 * @param data Its new data.
 */
export function setSourceData(map: MapLibreMap, sourceId: string, data: SourceData): void {
  updateSourceData(map.getSource<GeoJSONSource>(sourceId), data)
}

/**
 * As setSourceData, for a source already in hand.
 *
 * @param source The GeoJSON source, or undefined when the map doesn't have it (yet).
 * @param data Its new data.
 */
export function updateSourceData(source: GeoJSONSource | undefined, data: SourceData): void {
  source
    ?.setData(data)
    .catch((error: unknown) =>
      diagMap('map source update failed', { sourceId: source.id, error: String(error) })
    )
}
