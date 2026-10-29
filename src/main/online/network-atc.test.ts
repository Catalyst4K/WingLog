import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LatLon } from '@shared/geo'
import { getAirportCoords } from '../airports/airport-search'
import { parseAreaData, type AreaData } from './atc-areas'
import type { ControllerPosition, FeedAtis, FeedController, FeedSnapshot } from './feed-snapshot'
import { buildAtcLayer } from './network-atc'
import { parseVatsimFeed } from './vatsim-feed'

const data = parseAreaData(
  readFileSync(join(__dirname, '../../../resources/atc-areas.json'), 'utf8')
) as AreaData

const AIRPORTS: Record<string, LatLon> = {
  EGLL: { lat: 51.4706, lon: -0.4619 },
  EGKK: { lat: 51.1481, lon: -0.1903 },
  KJFK: { lat: 40.6398, lon: -73.7789 },
  PHNL: { lat: 21.3187, lon: -157.9224 },
  LKPR: { lat: 50.1008, lon: 14.26 }
}
const airportAt = (icao: string): LatLon | null => AIRPORTS[icao] ?? null

function controller(
  callsign: string,
  position: ControllerPosition,
  frequency = '118.700',
  name: string | null = null
): FeedController {
  return { callsign, frequency, position, name }
}

function snapshot(controllers: FeedController[], atis: FeedAtis[] = []): FeedSnapshot {
  return { network: 'vatsim', updatedMs: 0, receivedMs: 0, pilots: [], controllers, atis }
}

describe('buildAtcLayer', () => {
  it('draws a staffed centre as its area, with who is on it, and puts a sector on its own area', () => {
    const { areas, airports } = buildAtcLayer(
      snapshot([
        controller('LON_C_CTR', 'ctr', '133.700', 'Test Controller'),
        controller('LON_CTR', 'ctr', '135.100')
      ]),
      data,
      airportAt
    )
    expect(airports).toEqual([])
    expect(areas.map((a) => [a.kind, a.id, a.stations.map((s) => s.callsign)])).toEqual([
      ['centre', 'EGTT', ['LON_CTR']],
      ['centre', 'EGTT-C', ['LON_C_CTR']]
    ])
    const central = areas.find((a) => a.id === 'EGTT-C')!
    expect(central.name).toBe('London ACC (Central) - London')
    expect(central.stations[0]).toEqual({
      callsign: 'LON_C_CTR',
      frequency: '133.700',
      position: 'ctr',
      name: 'Test Controller'
    })
    expect(central.coordinates.length).toBeGreaterThan(0)
    expect(central.at).toEqual([-0.15, 52.178])
  })

  it('puts two controllers on one area into one entry, nearest the gate first and the same each time', () => {
    const feed = snapshot([
      controller('LON_CTR', 'ctr', '135.100'),
      controller('LON_N_CTR', 'ctr', '133.000'),
      controller('LON_CTR', 'ctr', '135.100')
    ])
    const first = buildAtcLayer(feed, data, airportAt)
    const again = buildAtcLayer({ ...feed, controllers: [...feed.controllers].reverse() }, data, airportAt)
    expect(again).toEqual(first)
    expect(first.areas.find((a) => a.id === 'EGTT')?.stations.map((s) => s.callsign)).toEqual([
      'LON_CTR',
      'LON_CTR'
    ])
  })

  it('draws an approach as its own area, and an approach with no area as its airport’s marker', () => {
    const { areas, airports } = buildAtcLayer(
      snapshot([controller('EGLL_APP', 'app', '119.725'), controller('LKPR_APP', 'app', '120.350')]),
      data,
      airportAt
    )
    expect(areas.map((a) => [a.kind, a.name, a.stations.map((s) => s.callsign)])).toEqual([
      ['approach', 'Heathrow Director', ['EGLL_APP']]
    ])
    expect(airports.map((a) => [a.icao, a.stations.map((s) => s.callsign)])).toEqual([['LKPR', ['LKPR_APP']]])
  })

  it('marks an airport with its delivery, ground and tower, nearest the gate first, at the airport’s position', () => {
    const { airports } = buildAtcLayer(
      snapshot([
        controller('EGLL_TWR', 'twr', '118.500'),
        controller('EGLL_DEL', 'del', '121.975'),
        controller('EGLL_GND', 'gnd', '121.700')
      ]),
      data,
      airportAt
    )
    expect(airports).toHaveLength(1)
    expect(airports[0]).toMatchObject({ icao: 'EGLL', at: [-0.4619, 51.4706], atis: [] })
    expect(airports[0]?.stations.map((s) => s.position)).toEqual(['del', 'gnd', 'twr'])
  })

  it('finds a US airport by its three-letter code, and an Alaskan or Hawaiian one by the P', () => {
    const { airports } = buildAtcLayer(
      snapshot([controller('JFK_TWR', 'twr'), controller('HNL_GND', 'gnd'), controller('KJFK_DEL', 'del')]),
      data,
      airportAt
    )
    expect(airports.map((a) => [a.icao, a.stations.map((s) => s.callsign)])).toEqual([
      ['KJFK', ['KJFK_DEL', 'JFK_TWR']],
      ['PHNL', ['HNL_GND']]
    ])
  })

  it('marks an airport that has only an ATIS, with the station’s letter and frequency', () => {
    const atis: FeedAtis = {
      callsign: 'EGKK_ATIS',
      code: 'B',
      lines: ['x'],
      frequency: '136.525',
      position: null
    }
    const { airports } = buildAtcLayer(snapshot([], [atis]), data, airportAt)
    expect(airports).toEqual([
      {
        icao: 'EGKK',
        at: [-0.1903, 51.1481],
        stations: [],
        atis: [{ callsign: 'EGKK_ATIS', code: 'B', frequency: '136.525' }]
      }
    ])
  })

  it('does not list IVAO’s ATIS, which is the controller’s and has no frequency of its own', () => {
    const atis: FeedAtis = { callsign: 'EGLL_TWR', code: 'H', lines: ['x'], frequency: null, position: 'twr' }
    const { airports } = buildAtcLayer(snapshot([controller('EGLL_TWR', 'twr')], [atis]), data, airportAt)
    expect(airports).toHaveLength(1)
    expect(airports[0]?.atis).toEqual([])
  })

  it('leaves out a controller whose airport has no position, a centre that names no area, and a callsign with no airport', () => {
    const { areas, airports } = buildAtcLayer(
      snapshot([
        controller('EGZZ_TWR', 'twr'),
        controller('ZZZZ_CTR', 'ctr'),
        controller('XY_TWR', 'twr'),
        controller('TWR', 'twr')
      ]),
      data,
      airportAt
    )
    expect(areas).toEqual([])
    expect(airports).toEqual([])
  })

  it('is empty for a feed with no controllers', () => {
    expect(buildAtcLayer(snapshot([]), data, airportAt)).toEqual({ areas: [], airports: [] })
  })

  it('carries no member number: a station is only a callsign, frequency, position and the network’s published name', () => {
    const { areas, airports } = buildAtcLayer(
      snapshot([controller('LON_C_CTR', 'ctr', '133.700', 'Test Controller'), controller('EGLL_TWR', 'twr')]),
      data,
      airportAt
    )
    const keys = new Set([...areas, ...airports].flatMap((a) => a.stations.flatMap((s) => Object.keys(s))))
    expect([...keys].sort()).toEqual(['callsign', 'frequency', 'name', 'position'])
  })
})

describe('buildAtcLayer on a recorded VATSIM feed', () => {
  it('finds the stations of the capture’s airports at their real positions', () => {
    const feed = parseVatsimFeed(
      JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'vatsim-observers.json'), 'utf8')),
      0
    )!
    const { airports } = buildAtcLayer(feed, data, (icao) => getAirportCoords(icao))
    const newark = airports.find((a) => a.icao === 'KEWR')
    expect(newark?.stations.map((s) => s.callsign)).toEqual(['EWR_GND'])
    expect(newark?.atis.map((a) => a.frequency)).toEqual(['134.825'])
    expect(newark?.at[0]).toBeCloseTo(-74.17, 1)
    expect(newark?.at[1]).toBeCloseTo(40.69, 1)
    // An observer is never a controller, so never on the map.
    expect(airports.flatMap((a) => a.stations).some((s) => s.callsign.startsWith('TESTOBS'))).toBe(false)
  })
})
