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
import type { PopupCard, PopupCardRow } from './map-popup'

/** A GeoJSON feature collection, the shape MapLibre's sources take. */
export interface FeatureCollection<Geometry, Properties> {
  type: 'FeatureCollection'
  features: { type: 'Feature'; geometry: Geometry; properties: Properties }[]
}

type Polygons = { type: 'MultiPolygon'; coordinates: number[][][][] }
type Point = { type: 'Point'; coordinates: [number, number] }

/** What a drawn area carries. `card` is the popup's content, as JSON, since a feature's property cannot hold a list. */
export interface AreaProperties {
  kind: AtcArea['kind']
  label: string
  card: string
}

/** What a drawn airport carries. */
export interface AirportProperties {
  label: string
  /** One letter for each kind of station staffed there, such as "D G T I". */
  letters: string
  card: string
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
 * @returns Its row: "CTR", the callsign, the frequency, and the name the network publishes.
 */
function stationRow(station: OnlineStation): PopupCardRow {
  return {
    tag: station.position.toUpperCase(),
    callsign: station.callsign,
    frequency: station.frequency,
    note: station.name
  }
}

/**
 * @param atis An ATIS station.
 * @returns Its row: "ATIS L" (the information letter, when it has one), the callsign and the frequency.
 */
function atisRow(atis: OnlineAtis): PopupCardRow {
  return {
    tag: atis.code ? `ATIS ${atis.code}` : 'ATIS',
    callsign: atis.callsign,
    frequency: atis.frequency,
    note: null
  }
}

/**
 * @param title The card's title.
 * @param rows Its rows.
 * @returns The card, as the JSON a feature's property holds.
 */
function cardJson(title: string, rows: PopupCardRow[]): string {
  const card: PopupCard = { title, rows }
  return JSON.stringify(card)
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
        card: cardJson(area.name, area.stations.map(stationRow))
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
        card: cardJson(area.name, area.stations.map(stationRow))
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
        card: cardJson(airport.icao, [...airport.stations.map(stationRow), ...airport.atis.map(atisRow)])
      }
    }))
  }
}

/**
 * @param properties A clicked feature's properties.
 * @returns The popup's card, or null when the property is not what this layer wrote. Only text is kept: a row that is not made of text
 *   is dropped.
 */
export function atcPopupCard(properties: { card?: unknown }): PopupCard | null {
  if (typeof properties.card !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(properties.card)
  } catch {
    return null
  }
  const card = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  if (!card || typeof card.title !== 'string' || !Array.isArray(card.rows)) return null
  const rows = (card.rows as unknown[]).flatMap((entry): PopupCardRow[] => {
    const row = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null
    if (
      !row ||
      typeof row.tag !== 'string' ||
      typeof row.callsign !== 'string' ||
      typeof row.frequency !== 'string'
    )
      return []
    return [
      {
        tag: row.tag,
        callsign: row.callsign,
        frequency: row.frequency,
        note: typeof row.note === 'string' ? row.note : null
      }
    ]
  })
  return { title: card.title, rows }
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
