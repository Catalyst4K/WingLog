/**
 * The bundled ATC coverage areas (`resources/atc-areas.json`, from VATSIM's community map data: the VAT-Spy Data Project and the SimAware
 * TRACON Project, CC BY-SA 4.0), and the two rules that find the area a controller's callsign names. Pure: the JSON text is an input, so
 * the rules are tested against the real file without the bundler. Plan: winglog-backend docs/plans/online-atc-map.md.
 *
 * The file is third-party data, parsed defensively: a shape that is not a polygon, a coordinate outside the world, or a name that is not
 * text drops that one area, and the rest still load. Only the callsign, never the feed's own text, picks an area.
 */

/** One area's shape and label. */
export interface AreaShape {
  name: string
  /** Where the label sits: [longitude, latitude]. */
  at: [number, number]
  /** A MultiPolygon's coordinates. */
  coordinates: number[][][][]
}

/** An approach or departure area, which the community data keys by callsign prefix and suffix. */
export interface ApproachShape extends AreaShape {
  id: string
}

/** The loaded data, indexed for the two rules. */
export interface AreaData {
  /** The releases it came from, for the manual's licence notice. */
  sources: { vatspy: string; tracon: string }
  /** Callsign prefix to area id ("LON_C" to "EGTT-C"). */
  prefixes: ReadonlyMap<string, string>
  /** ICAO code to area id: the fallback when no prefix matches ("CZVR" to "CZVR"). */
  icaoBoundaries: ReadonlyMap<string, string>
  /** An upper area to the codes of the areas it covers. */
  uirs: ReadonlyMap<string, string[]>
  /** Area id to its shape. */
  firs: ReadonlyMap<string, AreaShape>
  /** "PREFIX|SUFFIX" to the approach area it names (the suffix is APP or DEP). */
  approaches: ReadonlyMap<string, ApproachShape>
}

/** Limits that keep a corrupt file from taking the app's memory. */
const MAX_AREAS = 5000
const MAX_POINTS = 1_000_000
const MAX_TEXT = 200

/**
 * @param value Anything from the file.
 * @returns The record, or null for anything that is not a plain object.
 */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * @param value Anything from the file.
 * @returns The text, clipped, or null when it is not text.
 */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : null
}

/**
 * @param value Anything from the file.
 * @returns Whether this is a longitude and latitude on Earth.
 */
function isPoint(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  )
}

/**
 * @param value A MultiPolygon's coordinates, from the file.
 * @param budget How many points may still be read in all; reduced by what this reads.
 * @returns The coordinates, with every ring closed (the file's own rings are not always: 95 of the approach shapes, Heathrow Director
 *   among them, end one point short, and the map draws such a ring as wrong wedges), or null when any ring is not made of points, has
 *   fewer than three of them, or the budget is gone.
 */
function readCoordinates(value: unknown, budget: { points: number }): number[][][][] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const polygons: number[][][][] = []
  for (const polygon of value as unknown[]) {
    if (!Array.isArray(polygon) || polygon.length === 0) return null
    const rings: number[][][] = []
    for (const ring of polygon as unknown[]) {
      if (!Array.isArray(ring) || ring.length < 3) return null
      budget.points -= ring.length
      if (budget.points < 0) return null
      const points: number[][] = []
      for (const point of ring as unknown[]) {
        if (!isPoint(point)) return null
        points.push([point[0], point[1]])
      }
      const [first, last] = [points[0], points[points.length - 1]]
      if (first[0] !== last[0] || first[1] !== last[1]) points.push([first[0], first[1]])
      rings.push(points)
    }
    polygons.push(rings)
  }
  return polygons
}

/**
 * @param coordinates A shape's coordinates.
 * @returns The middle of the shape's bounding box, for a label the file does not place.
 */
function middleOf(coordinates: number[][][][]): [number, number] {
  let minLon = 180
  let maxLon = -180
  let minLat = 90
  let maxLat = -90
  for (const polygon of coordinates) {
    for (const [lon, lat] of polygon[0] ?? []) {
      minLon = Math.min(minLon, lon)
      maxLon = Math.max(maxLon, lon)
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
    }
  }
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2]
}

/**
 * @param entry One area from the file.
 * @param budget The points still allowed.
 * @returns Its shape, or null when it cannot be used.
 */
function readShape(entry: unknown, budget: { points: number }): AreaShape | null {
  const area = record(entry)
  const name = text(area?.name)
  const coordinates = readCoordinates(area?.coordinates, budget)
  if (!area || !name || !coordinates) return null
  return { name, at: isPoint(area.at) ? [area.at[0], area.at[1]] : middleOf(coordinates), coordinates }
}

/**
 * @param value A table of text to text from the file.
 * @returns The entries whose keys and values are text, keys in upper case.
 */
function textMap(value: unknown): Map<string, string> {
  const map = new Map<string, string>()
  for (const [key, entry] of Object.entries(record(value) ?? {})) {
    const target = text(entry)
    if (target) map.set(key.toUpperCase(), target)
  }
  return map
}

/**
 * @param value The file's table of areas by id.
 * @param budget The points still allowed.
 * @returns The areas that could be read.
 */
function readFirs(value: unknown, budget: { points: number }): Map<string, AreaShape> {
  const firs = new Map<string, AreaShape>()
  for (const [id, entry] of Object.entries(record(value) ?? {}).slice(0, MAX_AREAS)) {
    const shape = readShape(entry, budget)
    if (shape) firs.set(id, shape)
  }
  return firs
}

/**
 * @param value The file's list of approach and departure areas.
 * @param budget The points still allowed.
 * @returns Each area under every "PREFIX|SUFFIX" it names, the first one winning.
 */
function readApproaches(value: unknown, budget: { points: number }): Map<string, ApproachShape> {
  const approaches = new Map<string, ApproachShape>()
  const list = Array.isArray(value) ? (value as unknown[]).slice(0, MAX_AREAS) : []
  for (const entry of list) {
    const item = record(entry)
    const id = text(item?.id)
    const shape = readShape(item, budget)
    const suffix = item?.suffix === 'DEP' ? 'DEP' : 'APP'
    if (!item || !id || !shape || !Array.isArray(item.prefix)) continue
    for (const prefix of item.prefix as unknown[]) {
      const key = typeof prefix === 'string' ? `${prefix.toUpperCase()}|${suffix}` : null
      if (key && !approaches.has(key)) approaches.set(key, { id, ...shape })
    }
  }
  return approaches
}

/**
 * @param value The file's table of upper areas.
 * @returns Each upper area's id, in upper case, and the codes of the areas it covers.
 */
function readUirs(value: unknown): Map<string, string[]> {
  const uirs = new Map<string, string[]>()
  for (const [id, entry] of Object.entries(record(value) ?? {})) {
    const covered = record(entry)?.firs
    if (Array.isArray(covered)) {
      uirs.set(
        id.toUpperCase(),
        (covered as unknown[]).filter((code): code is string => typeof code === 'string')
      )
    }
  }
  return uirs
}

/**
 * @param raw The text of `resources/atc-areas.json`.
 * @returns The areas, or null when it is not that file at all.
 */
export function parseAreaData(raw: string): AreaData | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const file = record(json)
  const sources = record(file?.sources)
  if (!file || !sources) return null
  const budget = { points: MAX_POINTS }
  return {
    sources: { vatspy: text(sources.vatspy) ?? '', tracon: text(sources.tracon) ?? '' },
    prefixes: textMap(file.prefixes),
    icaoBoundaries: textMap(file.icaoBoundaries),
    uirs: readUirs(file.uirs),
    firs: readFirs(file.firs, budget),
    approaches: readApproaches(file.approaches, budget)
  }
}

/**
 * VAT-Spy's rule for a centre or FSS: the callsign without its last part, then shorter and shorter, against the prefix table, then the
 * ICAO table; an upper area names the areas it covers.
 *
 * @param data The loaded areas.
 * @param callsign A centre's or FSS's callsign, such as "LON_C_CTR".
 * @returns The ids of the areas it covers, empty when the data has none for it.
 */
export function centreAreaIds(data: AreaData, callsign: string): string[] {
  const parts = callsign.toUpperCase().split('_')
  parts.pop()
  for (let length = parts.length; length >= 1; length--) {
    const key = parts.slice(0, length).join('_')
    const id = data.prefixes.get(key) ?? data.icaoBoundaries.get(key)
    if (id !== undefined && data.firs.has(id)) return [id]
    const covered = data.uirs.get(key)
    if (covered) {
      const ids = covered.flatMap((code) => {
        const areaId = data.icaoBoundaries.get(code.toUpperCase())
        return areaId !== undefined && data.firs.has(areaId) ? [areaId] : []
      })
      if (ids.length > 0) return ids
    }
  }
  return []
}

/**
 * SimAware's rule for an approach or departure: the callsign's prefix with any middle part first ("LAX_U"), then the plain prefix, each
 * with the suffix (APP or DEP). An airport with no area of its own has none: nothing is drawn in its place.
 *
 * @param data The loaded areas.
 * @param callsign An approach's or departure's callsign, such as "EGLL_N_APP".
 * @returns The area, or null.
 */
export function approachArea(data: AreaData, callsign: string): ApproachShape | null {
  const parts = callsign.toUpperCase().split('_')
  const suffix = parts.pop()
  for (let length = parts.length; length >= 1; length--) {
    const found = data.approaches.get(`${parts.slice(0, length).join('_')}|${suffix}`)
    if (found) return found
  }
  return null
}
