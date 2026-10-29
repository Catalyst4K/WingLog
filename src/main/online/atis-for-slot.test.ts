import { describe, expect, it } from 'vitest'
import type { ControllerPosition, FeedAtis, FeedSnapshot } from './feed-snapshot'
import { answerAtis, atisForSlot } from './atis-for-slot'

function snapshot(network: 'vatsim' | 'ivao', atis: FeedAtis[]): FeedSnapshot {
  return { network, updatedMs: 0, receivedMs: 0, pilots: [], controllers: [], atis }
}

function vatsimAtis(callsign: string, code: string, lines: string[]): FeedAtis {
  return { callsign, code, lines, frequency: '128.075', position: null }
}

function ivaoAtis(callsign: string, position: ControllerPosition, code: string, lines: string[]): FeedAtis {
  return { callsign, code, lines, frequency: null, position }
}

const LONDON = snapshot('vatsim', [
  vatsimAtis('EGLL_D_ATIS', 'L', ['DEPARTURE INFORMATION LIMA', 'RUNWAY 27R IN USE']),
  vatsimAtis('EGLL_A_ATIS', 'M', ['ARRIVAL INFORMATION MIKE', 'RUNWAY 27L IN USE']),
  vatsimAtis('EGKK_ATIS', 'B', ['INFORMATION BRAVO', 'RUNWAY 26L IN USE']),
  vatsimAtis('EGCC_D_ATIS', 'C', ['DEPARTURE INFORMATION CHARLIE'])
])

describe('atisForSlot on VATSIM', () => {
  it('gives the departure tab the departure ATIS and the destination and alternate tabs the arrival one', () => {
    expect(atisForSlot(LONDON, 'EGLL', 'departure').map((a) => [a.callsign, a.code, a.kind])).toEqual([
      ['EGLL_D_ATIS', 'L', 'departure']
    ])
    for (const slot of ['destination', 'alternate'] as const) {
      expect(atisForSlot(LONDON, 'EGLL', slot).map((a) => [a.callsign, a.code, a.kind])).toEqual([
        ['EGLL_A_ATIS', 'M', 'arrival']
      ])
    }
  })

  it('names the one ATIS an airport has as single, for every tab', () => {
    for (const slot of ['departure', 'destination', 'alternate', 'custom'] as const) {
      expect(atisForSlot(LONDON, 'EGKK', slot).map((a) => [a.callsign, a.kind])).toEqual([
        ['EGKK_ATIS', 'single']
      ])
    }
  })

  it('shows the only ATIS an airport has as what it is, even on the other tab', () => {
    expect(atisForSlot(LONDON, 'EGCC', 'destination').map((a) => [a.callsign, a.kind])).toEqual([
      ['EGCC_D_ATIS', 'departure']
    ])
  })

  it('gives the custom tab every ATIS at the airport', () => {
    expect(atisForSlot(LONDON, 'EGLL', 'custom').map((a) => a.callsign)).toEqual([
      'EGLL_D_ATIS',
      'EGLL_A_ATIS'
    ])
  })

  it('names the runway only when the text names exactly one', () => {
    const [atis] = atisForSlot(LONDON, 'EGLL', 'departure')
    expect(atis?.runway).toBe('27R')
    const two = snapshot('vatsim', [vatsimAtis('LFPG_ATIS', 'A', ['RUNWAYS 26L AND 27R IN USE'])])
    expect(atisForSlot(two, 'LFPG', 'departure')[0]?.runway).toBeNull()
  })

  it('finds a US airport by its three-letter code too', () => {
    const us = snapshot('vatsim', [vatsimAtis('JFK_ATIS', 'Q', ['INFORMATION QUEBEC'])])
    expect(atisForSlot(us, 'KJFK', 'departure').map((a) => a.callsign)).toEqual(['JFK_ATIS'])
  })

  it('finds nothing at an airport with no ATIS, and never matches another airport', () => {
    expect(atisForSlot(LONDON, 'EGSS', 'departure')).toEqual([])
    expect(atisForSlot(LONDON, 'EGL', 'departure')).toEqual([])
  })

  it('passes the text on unchanged', () => {
    expect(atisForSlot(LONDON, 'EGKK', 'departure')[0]?.lines).toEqual([
      'INFORMATION BRAVO',
      'RUNWAY 26L IN USE'
    ])
  })
})

const LYON = snapshot('ivao', [
  ivaoAtis('LFLL_TWR', 'twr', 'H', ['tower text']),
  ivaoAtis('LFLL_GND', 'gnd', 'D', ['ground text']),
  ivaoAtis('LFLL_DEL', 'del', 'F', ['delivery text']),
  ivaoAtis('LFLL_APP', 'app', 'K', ['approach text']),
  ivaoAtis('LFLL_CTR', 'ctr', 'Z', ['a note about the sector']),
  ivaoAtis('LFBZ_GND', 'gnd', 'F', ['ground only'])
])

describe('atisForSlot on IVAO', () => {
  it('gives a departing pilot the first controller they would call: delivery, then ground, tower, approach', () => {
    expect(atisForSlot(LYON, 'LFLL', 'departure').map((a) => a.callsign)).toEqual(['LFLL_DEL'])
    const noDelivery = snapshot(
      'ivao',
      LYON.atis.filter((a) => a.callsign !== 'LFLL_DEL')
    )
    expect(atisForSlot(noDelivery, 'LFLL', 'departure').map((a) => a.callsign)).toEqual(['LFLL_GND'])
  })

  it('gives an arriving pilot approach first, then tower, ground, delivery', () => {
    for (const slot of ['destination', 'alternate'] as const) {
      expect(atisForSlot(LYON, 'LFLL', slot).map((a) => a.callsign)).toEqual(['LFLL_APP'])
    }
    const noApproach = snapshot(
      'ivao',
      LYON.atis.filter((a) => a.callsign !== 'LFLL_APP')
    )
    expect(atisForSlot(noApproach, 'LFLL', 'destination').map((a) => a.callsign)).toEqual(['LFLL_TWR'])
  })

  it('never uses a centre’s note as an airport’s ATIS, whatever the tab', () => {
    const centreOnly = snapshot('ivao', [ivaoAtis('LFLL_CTR', 'ctr', 'Z', ['a note'])])
    for (const slot of ['departure', 'destination', 'alternate', 'custom'] as const) {
      expect(atisForSlot(centreOnly, 'LFLL', slot)).toEqual([])
    }
  })

  it('gives the custom tab every controller’s ATIS at the airport, nearest the gate first, each with its own letter', () => {
    expect(atisForSlot(LYON, 'LFLL', 'custom').map((a) => [a.callsign, a.code])).toEqual([
      ['LFLL_APP', 'K'],
      ['LFLL_TWR', 'H'],
      ['LFLL_GND', 'D'],
      ['LFLL_DEL', 'F']
    ])
  })

  it('names every IVAO ATIS as single', () => {
    expect(atisForSlot(LYON, 'LFBZ', 'departure').map((a) => [a.callsign, a.kind])).toEqual([
      ['LFBZ_GND', 'single']
    ])
  })
})

describe('answerAtis', () => {
  it('answers each request in order, with its tab', () => {
    const answer = answerAtis(LONDON, 'vatsim', [
      { icao: 'EGLL', slot: 'departure' },
      { icao: 'EGLL', slot: 'destination' },
      { icao: 'EGSS', slot: 'alternate' }
    ])
    expect(answer.network).toBe('vatsim')
    expect(answer.airports.map((a) => [a.icao, a.slot, a.state, a.atis.map((x) => x.callsign)])).toEqual([
      ['EGLL', 'departure', 'shown', ['EGLL_D_ATIS']],
      ['EGLL', 'destination', 'shown', ['EGLL_A_ATIS']],
      ['EGSS', 'alternate', 'none', []]
    ])
  })

  it('shows nothing at all with no network chosen', () => {
    expect(answerAtis(LONDON, null, [{ icao: 'EGLL', slot: 'departure' }])).toEqual({
      network: null,
      airports: []
    })
  })

  it('says unavailable when there is no feed, or only the other network’s', () => {
    for (const held of [null, LYON]) {
      const answer = answerAtis(held, 'vatsim', [{ icao: 'EGLL', slot: 'departure' }])
      expect(answer.airports).toEqual([{ icao: 'EGLL', slot: 'departure', state: 'unavailable', atis: [] }])
    }
  })

  it('has no ATIS for ZZZZ, a free flight’s airport that is not set', () => {
    expect(answerAtis(LONDON, 'vatsim', [{ icao: 'ZZZZ', slot: 'departure' }]).airports[0]?.state).toBe(
      'none'
    )
  })
})
