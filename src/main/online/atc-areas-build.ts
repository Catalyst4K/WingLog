/**
 * Makes WingLog's ATC area file (`resources/atc-areas.json`, and the copy the app keeps up to date itself) out of the community's three
 * release files: the VAT-Spy Data Project's `VATSpy.dat` and `Boundaries.geojson`, and the SimAware TRACON Project's
 * `TRACONBoundaries.geojson`, all CC BY-SA 4.0. Pure: the text of the files is the input, so the script (`npm run data:atc-areas`) and the
 * app's own update run the one conversion. It keeps only what WingLog draws and rounds coordinates to 4 decimals (about 11 m). Plan:
 * winglog-backend docs/plans/online-atc-map.md and atc-areas-auto-update.md.
 *
 * The files are third-party data: every shape is checked here (a structure that is not what is expected throws, so nothing half-made is
 * kept) and again when WingLog loads the result (`parseAreaData`).
 */

interface Feature {
  properties: unknown
  geometry: { type?: unknown; coordinates?: unknown }
}
interface FirProperties {
  id?: unknown
  label_lon?: unknown
  label_lat?: unknown
  oceanic?: unknown
}
interface TraconProperties {
  id: unknown
  prefix: string[]
  suffix?: unknown
  name: unknown
  label_lon?: unknown
  label_lat?: unknown
}
interface FirArea {
  name: string
  at: [number, number] | null
  oceanic: boolean
  coordinates: number[][][][]
}

/** What the conversion reads: the files' text and the releases they came from. */
export interface AreaSourceFiles {
  /** `VATSpy.dat`. */
  dat: string
  /** `Boundaries.geojson`, as text. */
  boundaries: string
  /** `TRACONBoundaries.geojson`, as text. */
  tracon: string
  vatspyTag: string
  traconTag: string
}

/**
 * @param value A coordinate.
 * @returns It rounded to 4 decimals.
 */
const round = (value: number): number => Math.round(value * 1e4) / 1e4

/**
 * @param lon A label's longitude as the community data writes it (a number as text, or a number, or absent).
 * @param lat Its latitude.
 * @returns The label point, or null when either is missing or not a number.
 */
function labelPoint(lon: unknown, lat: unknown): [number, number] | null {
  if (lon === undefined || lat === undefined || lon === '' || lat === '') return null
  const point: [number, number] = [Number(lon), Number(lat)]
  return Number.isFinite(point[0]) && Number.isFinite(point[1]) ? [round(point[0]), round(point[1])] : null
}

/**
 * @param geometry A GeoJSON Polygon or MultiPolygon.
 * @returns Its rings as a MultiPolygon's coordinates, rounded.
 */
function multiPolygon(geometry: { type?: unknown; coordinates?: unknown }): number[][][][] {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  if ((geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') || !Array.isArray(polygons)) {
    throw new Error('Not a polygon')
  }
  return (polygons as number[][][][]).map((polygon) =>
    polygon.map((ring) => ring.map(([lon, lat]) => [round(lon), round(lat)]))
  )
}

/**
 * @param text VATSpy.dat.
 * @param section A section's name, such as "FIRs".
 * @returns That section's data lines, split on "|".
 */
function datSection(text: string, section: string): string[][] {
  const lines = text.split(/\r?\n/)
  const start = lines.indexOf(`[${section}]`)
  if (start < 0) throw new Error(`No [${section}] in VATSpy.dat`)
  const rows: string[][] = []
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('['); i++) {
    if (lines[i] && !lines[i].startsWith(';')) rows.push(lines[i].split('|'))
  }
  return rows
}

/**
 * @param text A GeoJSON file's text.
 * @returns Its features.
 */
function featuresOf(text: string): Feature[] {
  const parsed = JSON.parse(text) as { features?: unknown }
  if (!Array.isArray(parsed.features)) throw new Error('Not a feature collection')
  return parsed.features as Feature[]
}

/**
 * @param dat VATSpy.dat.
 * @returns The callsign-prefix tables: prefix to area id, ICAO code to area id, area id to name, and the upper areas.
 */
function prefixTables(dat: string): {
  prefixes: Record<string, string>
  icaoBoundaries: Record<string, string>
  names: Record<string, string>
  uirs: Record<string, { name: string; firs: string[] }>
} {
  // [FIRs]: ICAO|NAME|CALLSIGN PREFIX|FIR BOUNDARY. An empty prefix means the ICAO code is the prefix.
  const prefixes: Record<string, string> = {}
  const icaoBoundaries: Record<string, string> = {}
  const names: Record<string, string> = {}
  for (const [icao, name, prefix, boundary] of datSection(dat, 'FIRs')) {
    const id = boundary || icao
    prefixes[(prefix || icao).toUpperCase()] ??= id
    icaoBoundaries[icao.toUpperCase()] ??= id
    names[id] ??= name
  }
  // [UIRs]: ID|NAME|FIR,FIR,...
  const uirs: Record<string, { name: string; firs: string[] }> = {}
  for (const [id, name, firs] of datSection(dat, 'UIRs'))
    uirs[id.toUpperCase()] = { name, firs: firs.split(',') }
  return { prefixes, icaoBoundaries, names, uirs }
}

/**
 * @param features The boundaries' features.
 * @param names Area id to name, from VATSpy.dat.
 * @returns Each area by id, with its label point and rounded shape.
 */
function firAreas(features: Feature[], names: Record<string, string>): Record<string, FirArea> {
  const firs: Record<string, FirArea> = {}
  for (const feature of features) {
    const { id, label_lon: lon, label_lat: lat, oceanic } = feature.properties as FirProperties
    if (typeof id !== 'string') continue
    firs[id] = {
      name: names[id] ?? id,
      at: labelPoint(lon, lat),
      oceanic: oceanic === '1' || oceanic === 1 || oceanic === true,
      coordinates: multiPolygon(feature.geometry)
    }
  }
  return firs
}

/**
 * @param features The TRACON boundaries' features.
 * @returns Each approach or departure area, with its prefixes, label point and rounded shape.
 */
function approachAreas(features: Feature[]): object[] {
  return features.map((feature) => {
    const p = feature.properties as TraconProperties
    return {
      id: String(p.id),
      prefix: p.prefix.map((x) => x.toUpperCase()),
      suffix: p.suffix === 'DEP' ? 'DEP' : 'APP',
      name: String(p.name),
      at: labelPoint(p.label_lon, p.label_lat),
      coordinates: multiPolygon(feature.geometry)
    }
  })
}

/**
 * @param files The three release files' text and the releases they came from.
 * @returns The ATC area file's text.
 * @throws When a file is not shaped as the community's files are.
 */
export function buildAreaFile(files: AreaSourceFiles): string {
  const { prefixes, icaoBoundaries, names, uirs } = prefixTables(files.dat)
  return JSON.stringify({
    sources: { vatspy: files.vatspyTag, tracon: files.traconTag },
    prefixes,
    icaoBoundaries,
    uirs,
    firs: firAreas(featuresOf(files.boundaries), names),
    approaches: approachAreas(featuresOf(files.tracon))
  })
}
