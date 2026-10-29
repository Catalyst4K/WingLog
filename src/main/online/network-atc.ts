/**
 * What the map's ATC layer draws, from a feed: the staffed centre and approach areas, and the airports with a staffed delivery, ground,
 * tower or ATIS station. Pure: the feed, the area data and the airport positions are inputs, so the matching is tested without a service.
 * Plan: winglog-backend docs/plans/online-atc-map.md.
 *
 * Nothing is invented: an approach with no area in the community data is marked at its airport, never drawn as a made-up circle, and a
 * controller whose airport has no position is left out. Controllers never carry a member number or a position of their own (neither feed
 * gives one), so only their callsign, frequency and, on VATSIM, the name the network publishes are sent.
 */
import type { LatLon } from '@shared/geo'
import type { AtcAirport, AtcArea, OnlineStation, OnlineStationPosition } from '@shared/ipc'
import { prefixOf } from './airport-stations'
import { approachArea, centreAreaIds, type AreaData } from './atc-areas'
import type { FeedController, FeedSnapshot } from './feed-snapshot'

/** The order stations are listed in, from the gate outwards. */
const POSITION_ORDER: OnlineStationPosition[] = ['del', 'gnd', 'twr', 'app', 'ctr', 'fss']

/** What the layer draws. */
export interface AtcLayerContent {
  areas: AtcArea[]
  airports: AtcAirport[]
}

/**
 * @param controller A feed controller.
 * @returns It as a station.
 */
function stationOf(controller: FeedController): OnlineStation {
  return {
    callsign: controller.callsign,
    frequency: controller.frequency,
    position: controller.position,
    name: controller.name
  }
}

/**
 * @param stations A list of stations.
 * @returns It ordered from the gate outwards, then by callsign: the same feed always gives the same list.
 */
function ordered(stations: OnlineStation[]): OnlineStation[] {
  return [...stations].sort(
    (a, b) =>
      POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position) ||
      a.callsign.localeCompare(b.callsign)
  )
}

/**
 * @param callsign A callsign: the part before the first underscore is the airport's code.
 * @param airportAt Where an airport is, by its ICAO code.
 * @returns The airport's ICAO code and position. A three-letter code is a US airport's without its K (JFK for KJFK), or an Alaskan or
 *   Hawaiian one without its P; null when the code is neither or the airport is unknown.
 */
function airportOf(
  callsign: string,
  airportAt: (icao: string) => LatLon | null
): { icao: string; at: LatLon } | null {
  const prefix = prefixOf(callsign)
  const candidates = prefix.length === 4 ? [prefix] : prefix.length === 3 ? [`K${prefix}`, `P${prefix}`] : []
  for (const icao of candidates) {
    const at = airportAt(icao)
    if (at) return { icao, at }
  }
  return null
}

/**
 * @param snapshot The feed.
 * @param data The area data.
 * @param airportAt Where an airport is, by its ICAO code, or null when it is not known.
 * @returns The staffed areas and airports, in a fixed order so an unchanged feed gives an unchanged answer.
 */
export function buildAtcLayer(
  snapshot: FeedSnapshot,
  data: AreaData,
  airportAt: (icao: string) => LatLon | null
): AtcLayerContent {
  const areas = new Map<string, AtcArea>()
  const airports = new Map<string, AtcAirport>()

  const addToArea = (
    key: string,
    kind: AtcArea['kind'],
    shape: { id: string; name: string; at: [number, number]; coordinates: number[][][][] },
    station: OnlineStation
  ): void => {
    const area = areas.get(key) ?? {
      id: shape.id,
      kind,
      name: shape.name,
      at: shape.at,
      coordinates: shape.coordinates,
      stations: []
    }
    area.stations.push(station)
    areas.set(key, area)
  }
  const airportFor = (callsign: string): AtcAirport | null => {
    const found = airportOf(callsign, airportAt)
    if (!found) return null
    const existing = airports.get(found.icao)
    if (existing) return existing
    const airport: AtcAirport = { icao: found.icao, at: [found.at.lon, found.at.lat], stations: [], atis: [] }
    airports.set(found.icao, airport)
    return airport
  }

  for (const controller of snapshot.controllers) {
    const station = stationOf(controller)
    if (controller.position === 'ctr' || controller.position === 'fss') {
      for (const id of centreAreaIds(data, controller.callsign)) {
        const shape = data.firs.get(id)
        if (shape) addToArea(`centre|${id}`, 'centre', { id, ...shape }, station)
      }
    } else if (controller.position === 'app') {
      const area = approachArea(data, controller.callsign)
      if (area) addToArea(`approach|${area.id}`, 'approach', area, station)
      else airportFor(controller.callsign)?.stations.push(station)
    } else {
      airportFor(controller.callsign)?.stations.push(station)
    }
  }
  // An ATIS station with a frequency of its own (VATSIM's): IVAO's ATIS is the controller's, already listed.
  for (const atis of snapshot.atis) {
    if (atis.frequency === null) continue
    airportFor(atis.callsign)?.atis.push({
      callsign: atis.callsign,
      code: atis.code,
      frequency: atis.frequency
    })
  }

  return {
    areas: [...areas.values()]
      .map((area) => ({ ...area, stations: ordered(area.stations) }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
    airports: [...airports.values()]
      .map((airport) => ({
        ...airport,
        stations: ordered(airport.stations),
        atis: [...airport.atis].sort((a, b) => a.callsign.localeCompare(b.callsign))
      }))
      .sort((a, b) => a.icao.localeCompare(b.icao))
  }
}
