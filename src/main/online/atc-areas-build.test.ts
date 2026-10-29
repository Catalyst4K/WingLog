import { describe, expect, it } from 'vitest'
import { parseAreaData } from './atc-areas'
import { buildAreaFile, type AreaSourceFiles } from './atc-areas-build'

const SQUARE = [
  [
    [
      [-0.123456, 51.5],
      [0.1, 51.5],
      [0.1, 51.6],
      [-0.1, 51.6],
      [-0.123456, 51.5]
    ]
  ]
]

const DAT = [
  '[Countries]',
  'United Kingdom|EG|',
  '[FIRs]',
  ';ICAO|NAME|PREFIX|BOUNDARY',
  'EGTT|London|||',
  'EGTT|London (Central)|LON_C|EGTT-C',
  'LFFF|Paris||',
  '[UIRs]',
  'EUE|Europe Upper|EGTT,LFFF',
  '[IDL]'
].join('\r\n')

const BOUNDARIES = JSON.stringify({
  features: [
    {
      properties: { id: 'EGTT-C', label_lon: '-0.15', label_lat: '52.178123', oceanic: '0' },
      geometry: { type: 'MultiPolygon', coordinates: SQUARE }
    },
    {
      properties: { id: 'LFFF', oceanic: 1 },
      geometry: { type: 'Polygon', coordinates: SQUARE[0] }
    },
    { properties: { name: 'no id' }, geometry: { type: 'Polygon', coordinates: SQUARE[0] } }
  ]
})

const TRACON = JSON.stringify({
  features: [
    {
      properties: {
        id: 'EGLL',
        prefix: ['egll', 'EGLL_N'],
        suffix: 'DEP',
        name: 'Heathrow Director',
        label_lon: 0.5,
        label_lat: 51.5
      },
      geometry: { type: 'Polygon', coordinates: SQUARE[0] }
    }
  ]
})

function files(overrides: Partial<AreaSourceFiles> = {}): AreaSourceFiles {
  return {
    dat: DAT,
    boundaries: BOUNDARIES,
    tracon: TRACON,
    vatspyTag: 'v2610.1',
    traconTag: 'v1.2.13',
    ...overrides
  }
}

/** The built file, as far as these tests read it. */
interface BuiltFile {
  sources: unknown
  prefixes: unknown
  icaoBoundaries: unknown
  uirs: unknown
  firs: Record<string, { name: string; at: unknown; oceanic: boolean; coordinates: unknown[] }>
  approaches: unknown
}

describe('buildAreaFile', () => {
  const built = JSON.parse(buildAreaFile(files())) as BuiltFile

  it('records the releases it was made from', () => {
    expect(built.sources).toEqual({ vatspy: 'v2610.1', tracon: 'v1.2.13' })
  })

  it('keys the callsign prefixes to their area, an empty prefix meaning the ICAO code, the first line winning', () => {
    expect(built.prefixes).toEqual({ EGTT: 'EGTT', LON_C: 'EGTT-C', LFFF: 'LFFF' })
    expect(built.icaoBoundaries).toEqual({ EGTT: 'EGTT', LFFF: 'LFFF' })
  })

  it('reads the upper areas', () => {
    expect(built.uirs).toEqual({ EUE: { name: 'Europe Upper', firs: ['EGTT', 'LFFF'] } })
  })

  it('draws each area with its name from the dat file, its label and its shape rounded to four decimals', () => {
    expect(built.firs['EGTT-C']).toEqual({
      name: 'London (Central)',
      at: [-0.15, 52.1781],
      oceanic: false,
      coordinates: [
        [
          [
            [-0.1235, 51.5],
            [0.1, 51.5],
            [0.1, 51.6],
            [-0.1, 51.6],
            [-0.1235, 51.5]
          ]
        ]
      ]
    })
  })

  it('takes a Polygon as a one-polygon MultiPolygon, an oceanic flag as a number, no label as null, and skips a feature with no id', () => {
    expect(built.firs.LFFF).toMatchObject({ name: 'Paris', at: null, oceanic: true })
    expect(built.firs.LFFF.coordinates).toHaveLength(1)
    expect(Object.keys(built.firs)).toEqual(['EGTT-C', 'LFFF'])
  })

  it('makes approach areas with upper-case prefixes, DEP kept and anything else APP, and the label as a number', () => {
    expect(built.approaches).toEqual([
      {
        id: 'EGLL',
        prefix: ['EGLL', 'EGLL_N'],
        suffix: 'DEP',
        name: 'Heathrow Director',
        at: [0.5, 51.5],
        coordinates: [[SQUARE[0][0].map(([lon, lat]) => [Math.round(lon * 1e4) / 1e4, lat])]]
      }
    ])
  })

  it('makes a file WingLog’s own loader reads back whole', () => {
    const data = parseAreaData(buildAreaFile(files()))
    expect(data?.sources).toEqual({ vatspy: 'v2610.1', tracon: 'v1.2.13' })
    expect(data?.firs.size).toBe(2)
    expect(data?.approaches.get('EGLL|DEP')?.name).toBe('Heathrow Director')
  })

  it('refuses a dat file with no [FIRs] or [UIRs] section', () => {
    expect(() => buildAreaFile(files({ dat: '[UIRs]\r\n' }))).toThrow('No [FIRs]')
    expect(() => buildAreaFile(files({ dat: '[FIRs]\r\nEGTT|London|||' }))).toThrow('No [UIRs]')
  })

  it('refuses boundaries that are not a feature collection, or a shape that is not a polygon', () => {
    expect(() => buildAreaFile(files({ boundaries: '{"features":"no"}' }))).toThrow(
      'Not a feature collection'
    )
    expect(() => buildAreaFile(files({ boundaries: 'not json' }))).toThrow()
    const point = JSON.stringify({
      features: [{ properties: { id: 'X' }, geometry: { type: 'Point', coordinates: [0, 0] } }]
    })
    expect(() => buildAreaFile(files({ boundaries: point }))).toThrow('Not a polygon')
  })
})
