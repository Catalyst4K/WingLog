import { describe, expect, it } from 'vitest'
import type { AtcAirport, AtcArea, NetworkAtc, OnlineStation } from '@shared/ipc'
import {
  airportFeatures,
  airportLetters,
  areaFeatures,
  areaLabelFeatures,
  atcPopupLines,
  layerData
} from './atc-features'

const SQUARE = [
  [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0]
    ]
  ]
]

function station(
  callsign: string,
  position: OnlineStation['position'],
  frequency = '118.700',
  name: string | null = null
): OnlineStation {
  return { callsign, frequency, position, name }
}

const LONDON: AtcArea = {
  id: 'EGTT-C',
  kind: 'centre',
  name: 'London ACC (Central) - London',
  at: [-0.15, 52.178],
  coordinates: SQUARE,
  stations: [
    station('LON_C_CTR', 'ctr', '133.700', 'Test Controller'),
    station('LON_CS_CTR', 'ctr', '135.100')
  ]
}

const HEATHROW: AtcAirport = {
  icao: 'EGLL',
  at: [-0.4619, 51.4706],
  stations: [station('EGLL_GND', 'gnd', '121.700'), station('EGLL_TWR', 'twr', '118.500')],
  atis: [{ callsign: 'EGLL_D_ATIS', code: 'L', frequency: '121.850' }]
}

describe('areaFeatures', () => {
  it('gives each area its shape as it is, its kind, the first controller’s callsign as its label, and the popup’s lines', () => {
    const [feature] = areaFeatures([LONDON]).features
    expect(feature?.geometry).toEqual({ type: 'MultiPolygon', coordinates: SQUARE })
    expect(feature?.properties.kind).toBe('centre')
    expect(feature?.properties.label).toBe('LON_C_CTR')
    expect(atcPopupLines(feature!.properties)).toEqual([
      'London ACC (Central) - London',
      'LON_C_CTR 133.700 — Test Controller',
      'LON_CS_CTR 135.100'
    ])
  })

  it('is empty for no areas', () => {
    expect(areaFeatures([])).toEqual({ type: 'FeatureCollection', features: [] })
  })
})

describe('areaLabelFeatures', () => {
  it('puts a label point at each area’s own label place, with the same label and kind', () => {
    const [feature] = areaLabelFeatures([{ ...LONDON, kind: 'approach' }]).features
    expect(feature?.geometry).toEqual({ type: 'Point', coordinates: [-0.15, 52.178] })
    expect(feature?.properties).toMatchObject({ kind: 'approach', label: 'LON_C_CTR' })
  })
})

describe('airportLetters', () => {
  it('names what is staffed in a fixed order, one letter each', () => {
    const letters = (stations: OnlineStation[], atis = 0): string =>
      airportLetters({
        icao: 'EGLL',
        at: [0, 0],
        stations,
        atis: Array.from({ length: atis }, (_, i) => ({
          callsign: `A${i}`,
          code: null,
          frequency: '128.000'
        }))
      })
    expect(letters([station('a', 'twr'), station('b', 'del'), station('c', 'gnd')], 1)).toBe('D G T I')
    expect(letters([station('a', 'app')])).toBe('A')
    expect(letters([], 2)).toBe('I')
    expect(letters([station('a', 'twr'), station('b', 'twr')])).toBe('T')
  })
})

describe('airportFeatures', () => {
  it('puts a point at each airport, with its code, its letters and the popup’s lines', () => {
    const [feature] = airportFeatures([HEATHROW]).features
    expect(feature?.geometry).toEqual({ type: 'Point', coordinates: [-0.4619, 51.4706] })
    expect(feature?.properties).toMatchObject({ label: 'EGLL', letters: 'G T I' })
    expect(atcPopupLines(feature!.properties)).toEqual([
      'EGLL',
      'EGLL_GND 121.700',
      'EGLL_TWR 118.500',
      'EGLL_D_ATIS 121.850 (L)'
    ])
  })

  it('leaves out the letter in brackets for an ATIS with none', () => {
    const airport = {
      ...HEATHROW,
      stations: [],
      atis: [{ callsign: 'EGLL_ATIS', code: null, frequency: '128.075' }]
    }
    expect(atcPopupLines(airportFeatures([airport]).features[0]!.properties)).toEqual([
      'EGLL',
      'EGLL_ATIS 128.075'
    ])
  })
})

describe('atcPopupLines', () => {
  it('keeps the text as it came, never as markup', () => {
    const lines = atcPopupLines({
      lines: JSON.stringify(['<img src=x onerror=alert(1)>', 'EGLL_TWR 118.500'])
    })
    expect(lines).toEqual(['<img src=x onerror=alert(1)>', 'EGLL_TWR 118.500'])
  })

  it.each([[undefined], [5], ['not json'], ['{"a":1}'], ['null']])('is empty for %j', (value) => {
    expect(atcPopupLines({ lines: value })).toEqual([])
  })

  it('drops anything in the list that is not text', () => {
    expect(atcPopupLines({ lines: JSON.stringify(['title', 5, null, 'row']) })).toEqual(['title', 'row'])
  })
})

describe('layerData', () => {
  const shown = (areas: AtcArea[], airports: AtcAirport[]): NetworkAtc => ({
    network: 'vatsim',
    state: 'shown',
    areas,
    airports
  })

  it('has the three collections for a shown layer', () => {
    const data = layerData(shown([LONDON], [HEATHROW]))
    expect([data.areas.features.length, data.labels.features.length, data.airports.features.length]).toEqual([
      1, 1, 1
    ])
  })

  it.each([['off'], ['noNetwork'], ['needsVid'], ['unavailable']] as const)(
    'is empty while the layer is %s, whatever it holds',
    (state) => {
      const data = layerData({ ...shown([LONDON], [HEATHROW]), state })
      expect([
        data.areas.features.length,
        data.labels.features.length,
        data.airports.features.length
      ]).toEqual([0, 0, 0])
    }
  )

  it('is empty before the topic has arrived', () => {
    expect(layerData(null).areas.features).toEqual([])
  })
})
