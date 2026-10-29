/**
 * What the ATC layer puts on the map, as GeoJSON, from the `networkAtc` topic: pure, so it is tested without a map (winglog-backend
 * docs/plans/online-atc-map.md). Every string came from a network feed, so each is only ever a property value drawn as text or put in a
 * popup built from text nodes, never parsed as HTML.
 */
import type {
  AtcAirport,
  AtcArea,
  NetworkAtc,
  OnlineAtis,
  OnlineStation,
  OnlineStationPosition
} from '@shared/ipc'

/** A GeoJSON feature collection, the shape MapLibre's sources take. */
export interface FeatureCollection<Geometry, Properties> {
  type: 'FeatureCollection'
  features: { type: 'Feature'; geometry: Geometry; properties: Properties }[]
}

type Polygons = { type: 'MultiPolygon'; coordinates: number[][][][] }
type Point = { type: 'Point'; coordinates: [number, number] }

/** What a drawn area carries. `lines` is the popup's text, as JSON, since a feature's property cannot hold a list. */
export interface AreaProperties {
  kind: AtcArea['kind']
  label: string
  lines: string
}

/** What a drawn airport carries. */
export interface AirportProperties {
  label: string
  /** One letter for each kind of station staffed there, such as "D G T I". */
  letters: string
  lines: string
}

/** Aviation abbreviations stay in English in every language. */
const STATION_LETTERS: Record<OnlineStationPosition, string> = {
  del: 'D',
  gnd: 'G',
  twr: 'T',
  app: 'A',
  ctr: 'C',
  fss: 'F'
}
const LETTER_ORDER = ['D', 'G', 'T', 'A', 'I']

/**
 * @param station A station.
 * @returns "LON_C_CTR 133.700", with the name the network publishes after a dash.
 */
function stationLine(station: OnlineStation): string {
  return `${station.callsign} ${station.frequency}${station.name ? ` — ${station.name}` : ''}`
}

/**
 * @param atis An ATIS station.
 * @returns "EGLL_D_ATIS 121.850 (L)".
 */
function atisLine(atis: OnlineAtis): string {
  return `${atis.callsign} ${atis.frequency}${atis.code ? ` (${atis.code})` : ''}`
}

/**
 * @param areas The staffed areas.
 * @returns The areas' shapes, one feature each, coloured by `kind` in the style.
 */
export function areaFeatures(areas: AtcArea[]): FeatureCollection<Polygons, AreaProperties> {
  return {
    type: 'FeatureCollection',
    features: areas.map((area) => ({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: area.coordinates },
      properties: {
        kind: area.kind,
        label: area.stations[0]?.callsign ?? area.id,
        lines: JSON.stringify([area.name, ...area.stations.map(stationLine)])
      }
    }))
  }
}

/**
 * @param areas The staffed areas.
 * @returns A point at each area's label place, carrying the first station's callsign as the label.
 */
export function areaLabelFeatures(areas: AtcArea[]): FeatureCollection<Point, AreaProperties> {
  return {
    type: 'FeatureCollection',
    features: areas.map((area) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: area.at },
      properties: {
        kind: area.kind,
        label: area.stations[0]?.callsign ?? area.id,
        lines: JSON.stringify([area.name, ...area.stations.map(stationLine)])
      }
    }))
  }
}

/**
 * @param airport An airport with staffed stations.
 * @returns The letters of what is staffed there, in a fixed order: D, G, T, A (an approach with no area of its own), I (ATIS).
 */
export function airportLetters(airport: AtcAirport): string {
  const letters = new Set<string>(airport.stations.map((s) => STATION_LETTERS[s.position]))
  if (airport.atis.length > 0) letters.add('I')
  return LETTER_ORDER.filter((letter) => letters.has(letter)).join(' ')
}

/**
 * @param airports The airports with something staffed.
 * @returns A point at each, with its letters and popup text.
 */
export function airportFeatures(airports: AtcAirport[]): FeatureCollection<Point, AirportProperties> {
  return {
    type: 'FeatureCollection',
    features: airports.map((airport) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: airport.at },
      properties: {
        label: airport.icao,
        letters: airportLetters(airport),
        lines: JSON.stringify([
          airport.icao,
          ...airport.stations.map(stationLine),
          ...airport.atis.map(atisLine)
        ])
      }
    }))
  }
}

/**
 * @param properties A clicked feature's properties.
 * @returns The popup's lines: the first is the title. Empty when the property is not what this layer wrote.
 */
export function atcPopupLines(properties: { lines?: unknown }): string[] {
  if (typeof properties.lines !== 'string') return []
  try {
    const lines: unknown = JSON.parse(properties.lines)
    return Array.isArray(lines) ? lines.filter((line): line is string => typeof line === 'string') : []
  } catch {
    return []
  }
}

/**
 * @param atc The topic's latest value, or null before it arrives.
 * @returns The three feature collections for it, empty ones for anything that is not shown.
 */
export function layerData(atc: NetworkAtc | null): {
  areas: FeatureCollection<Polygons, AreaProperties>
  labels: FeatureCollection<Point, AreaProperties>
  airports: FeatureCollection<Point, AirportProperties>
} {
  const shown = atc?.state === 'shown' ? atc : null
  return {
    areas: areaFeatures(shown?.areas ?? []),
    labels: areaLabelFeatures(shown?.areas ?? []),
    airports: airportFeatures(shown?.airports ?? [])
  }
}
