import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { airportPrefixes, stationsAt } from './airport-stations'
import type { FeedController, FeedSnapshot } from './feed-snapshot'
import { parseIvaoFeed } from './ivao-feed'
import { parseVatsimFeed } from './vatsim-feed'

function controller(
  callsign: string,
  position: FeedController['position'] = 'twr',
  name: string | null = null
): FeedController {
  return { callsign, frequency: '118.700', position, name }
}

function snapshot(controllers: FeedController[], atis: FeedSnapshot['atis'] = []): FeedSnapshot {
  return { network: 'vatsim', updatedMs: 0, receivedMs: 0, pilots: [], controllers, atis }
}

describe('airportPrefixes', () => {
  it('is the ICAO code, and for a US airport the three-letter code as well', () => {
    expect(airportPrefixes('EGLL')).toEqual(['EGLL'])
    expect(airportPrefixes('KJFK')).toEqual(['KJFK', 'JFK'])
    expect(airportPrefixes('PHNL')).toEqual(['PHNL', 'HNL'])
    expect(airportPrefixes('egll')).toEqual(['EGLL'])
  })

  it('does not shorten a code that is not a four-letter US one', () => {
    expect(airportPrefixes('CYYZ')).toEqual(['CYYZ'])
    expect(airportPrefixes('K')).toEqual(['K'])
    expect(airportPrefixes('KJFKX')).toEqual(['KJFKX'])
  })
})

describe('stationsAt', () => {
  it('matches the part before the first underscore, whatever follows', () => {
    const result = stationsAt(
      snapshot([
        controller('EGLL_TWR'),
        controller('EGLL_N_APP', 'app'),
        controller('EGLL_ATIS_X', 'gnd'),
        controller('EGLC_TWR')
      ]),
      ['EGLL']
    )
    expect(result[0]?.stations.map((s) => s.callsign)).toEqual(['EGLL_ATIS_X', 'EGLL_TWR', 'EGLL_N_APP'])
  })

  it('finds a US airport’s stations by its three-letter code, including ones with a middle part', () => {
    const result = stationsAt(
      snapshot([
        controller('JFK_TWR'),
        controller('DFW_E_TWR'),
        controller('KJFK_GND', 'gnd'),
        controller('HOU_46_CTR', 'ctr')
      ]),
      ['KJFK', 'KDFW', 'KHOU']
    )
    expect(result.map((r) => r.stations.map((s) => s.callsign))).toEqual([
      ['KJFK_GND', 'JFK_TWR'],
      ['DFW_E_TWR'],
      ['HOU_46_CTR']
    ])
  })

  it('lists stations from the gate outwards: delivery, ground, tower, approach, centre, FSS', () => {
    const result = stationsAt(
      snapshot([
        controller('EGLL_FSS', 'fss'),
        controller('EGLL_CTR', 'ctr'),
        controller('EGLL_APP', 'app'),
        controller('EGLL_TWR', 'twr'),
        controller('EGLL_GND', 'gnd'),
        controller('EGLL_DEL', 'del')
      ]),
      ['EGLL']
    )
    expect(result[0]?.stations.map((s) => s.position)).toEqual(['del', 'gnd', 'twr', 'app', 'ctr', 'fss'])
  })

  it('does not confuse an airport with another that merely starts alike', () => {
    expect(
      stationsAt(snapshot([controller('EGLLX_TWR'), controller('EGL_TWR')]), ['EGLL'])[0]?.stations
    ).toEqual([])
  })

  it('matches without regard to case and trims the airport codes, ignoring blanks and repeats', () => {
    const result = stationsAt(snapshot([controller('egll_twr')]), [' egll ', 'EGLL', ''])
    expect(result).toHaveLength(1)
    expect(result[0]?.icao).toBe('EGLL')
    expect(result[0]?.stations).toHaveLength(1)
  })

  it('carries the name VATSIM publishes and the ATIS as text', () => {
    const result = stationsAt(
      snapshot(
        [controller('EGLL_TWR', 'twr', 'Test Controller')],
        [{ callsign: 'EGLL_ATIS', code: 'C', lines: ['<b>WIND CALM</b>'] }]
      ),
      ['EGLL']
    )
    expect(result[0]?.stations[0]?.name).toBe('Test Controller')
    expect(result[0]?.atis).toEqual([{ callsign: 'EGLL_ATIS', code: 'C', lines: ['<b>WIND CALM</b>'] }])
  })

  it('gives an airport with nobody online as an empty entry', () => {
    expect(stationsAt(snapshot([]), ['EGLL'])).toEqual([{ icao: 'EGLL', stations: [], atis: [] }])
  })

  it('is empty for no airports', () => {
    expect(stationsAt(snapshot([controller('EGLL_TWR')]), [])).toEqual([])
  })

  describe('against the recorded feeds', () => {
    const read = (name: string): unknown =>
      JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'))

    it('finds Newark’s ground and ATIS in the VATSIM capture by their three-letter and ICAO callsigns, and never an observer', () => {
      const feed = parseVatsimFeed(read('vatsim-observers.json'), 0)!
      const [newark] = stationsAt(feed, ['KEWR'])
      expect(newark?.stations.map((s) => s.callsign)).toEqual(['EWR_GND'])
      expect(newark?.atis.map((a) => [a.callsign, a.code])).toEqual([['KEWR_ATIS', 'C']])
      expect(newark?.atis[0]?.lines.join(' ')).toContain('ILS RWY 22L')
      const all = stationsAt(feed, ['KEWR', 'KLGA', 'KJFK'])
      expect(all.flatMap((a) => a.stations).some((s) => s.callsign.startsWith('TESTOBS'))).toBe(false)
    })

    it('finds the synthetic IVAO tower with its frequency formatted the same way', () => {
      const feed = parseIvaoFeed(read('ivao-synthetic.json'), 0)!
      const [airport] = stationsAt(feed, ['TSTA'])
      expect(airport?.stations.map((s) => [s.position, s.frequency, s.name])).toEqual([
        ['gnd', '121.700', null],
        ['twr', '118.100', null],
        ['app', '119.725', null]
      ])
    })
  })
})
