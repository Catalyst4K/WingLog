/** The planned route in a flight's OFP JSON, shared by the main process and the renderer. */

/**
 * @param ofpJson The OFP JSON, or null.
 * @returns The navlog's fixes, or an empty list for a missing, unparseable or oddly shaped OFP.
 */
export function navlogFixes(ofpJson: string | null): Record<string, unknown>[] {
  if (!ofpJson) return []
  try {
    const parsed: unknown = JSON.parse(ofpJson)
    const fixes = (parsed as { navlog?: { fix?: unknown } })?.navlog?.fix
    return Array.isArray(fixes) ? (fixes as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}

/**
 * Extracts the planned route as [lon, lat] pairs (GeoJSON order) from a flight's raw SimBrief OFP JSON, specifically
 * `navlog.fix[].pos_lat`/`pos_long` (docs/decisions.md dispatch entry). Returns an empty route rather than
 * throwing on anything unexpected: a missing planned route just means the map has no line to draw.
 *
 * @param ofpJson The OFP JSON, or null.
 * @returns The route's [lon, lat] pairs.
 */
export function parseRouteFromOfpJson(ofpJson: string | null): [number, number][] {
  const points: [number, number][] = []
  for (const fix of navlogFixes(ofpJson)) {
    const lon = Number(fix.pos_long)
    const lat = Number(fix.pos_lat)
    if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lon, lat])
  }
  return points
}
