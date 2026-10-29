import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { approachArea, centreAreaIds, parseAreaData, type AreaData } from './atc-areas'

const real = parseAreaData(
  readFileSync(join(__dirname, '../../../resources/atc-areas.json'), 'utf8')
) as AreaData

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

/** A small file of the same shape, for the cases the real one does not have. */
function file(changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sources: { vatspy: 'v1', tracon: 'v2' },
    prefixes: { LON: 'EGTT', LON_C: 'EGTT-C' },
    icaoBoundaries: { EGTT: 'EGTT', CZVR: 'CZVR', LFFF: 'LFFF', LFRR: 'LFRR' },
    uirs: { FRA: { name: 'France', firs: ['LFFF', 'LFRR', 'XXXX'] } },
    firs: {
      EGTT: { name: 'London', at: [-1, 52], oceanic: false, coordinates: SQUARE },
      'EGTT-C': { name: 'London ACC (Central) - London', at: null, oceanic: false, coordinates: SQUARE },
      CZVR: { name: 'Vancouver', at: [-123, 49], oceanic: false, coordinates: SQUARE },
      LFFF: { name: 'Paris', at: [2, 48], oceanic: false, coordinates: SQUARE },
      LFRR: { name: 'Brest', at: [-4, 48], oceanic: false, coordinates: SQUARE }
    },
    approaches: [
      {
        id: 'SCT',
        prefix: ['LAX', 'SAN'],
        suffix: 'APP',
        name: 'SoCal Approach',
        at: [-118, 34],
        coordinates: SQUARE
      },
      { id: 'SCT', prefix: ['LAX'], suffix: 'DEP', name: 'SoCal Departure', at: null, coordinates: SQUARE },
      { id: 'LAXU', prefix: ['LAX_U'], suffix: 'APP', name: 'LAX Upper', at: null, coordinates: SQUARE }
    ],
    ...changes
  })
}

describe('parseAreaData on the bundled file', () => {
  it('loads the whole of it, with the releases it came from', () => {
    expect(real.firs.size).toBeGreaterThan(1000)
    expect(real.approaches.size).toBeGreaterThan(1000)
    expect(real.prefixes.size).toBeGreaterThan(1000)
    expect(real.sources.vatspy).toMatch(/^v\d{4}\.\d+$/)
    expect(real.sources.tracon).toMatch(/^v\d+\.\d+\.\d+$/)
  })

  it('gives every area a shape on Earth and a label point', () => {
    for (const area of real.firs.values()) {
      expect(area.coordinates.length).toBeGreaterThan(0)
      expect(Math.abs(area.at[0])).toBeLessThanOrEqual(180)
      expect(Math.abs(area.at[1])).toBeLessThanOrEqual(90)
    }
  })
})

describe('rings', () => {
  it('are closed on every shape of the bundled file, Heathrow Director included (its ring ends one point short in the file)', () => {
    const heathrow = approachArea(real, 'EGLL_APP')
    expect(heathrow?.coordinates[0][0]).toHaveLength(8)
    for (const area of [...real.firs.values(), ...real.approaches.values()]) {
      for (const polygon of area.coordinates) {
        for (const ring of polygon) expect(ring[0]).toEqual(ring[ring.length - 1])
      }
    }
  })

  it('are closed when the file leaves one open, and left alone when it is already closed', () => {
    const open = [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1]
        ]
      ]
    ]
    const data = parseAreaData(
      file({
        firs: {
          EGTT: { name: 'London', at: [-1, 52], coordinates: open },
          CZVR: { name: 'Vancouver', at: [-123, 49], coordinates: SQUARE }
        }
      })
    ) as AreaData
    expect(data.firs.get('EGTT')?.coordinates[0][0]).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0]
    ])
    expect(data.firs.get('CZVR')?.coordinates).toEqual(SQUARE)
  })
})

describe('centreAreaIds on the bundled file', () => {
  it('finds a centre by its callsign prefix, and a sector by its longer one', () => {
    expect(centreAreaIds(real, 'LON_C_CTR')).toEqual(['EGTT-C'])
    expect(centreAreaIds(real, 'LON_CTR')).toEqual(['EGTT'])
    expect(centreAreaIds(real, 'SCO_BDS_CTR')).toEqual(['EGPX-BDS'])
  })

  it('falls back to the ICAO code when the prefix table does not name it (the real capture’s Vancouver, Moncton and Edmonton)', () => {
    expect(centreAreaIds(real, 'CZVR_CTR')).toEqual(['CZVR'])
    expect(centreAreaIds(real, 'EGPX_CTR')).toEqual(['EGPX'])
    expect(centreAreaIds(real, 'CZEG_FSS')).toEqual(['CZEG'])
  })

  it('is empty for a callsign that names no area, and for a bare one', () => {
    expect(centreAreaIds(real, 'ZZZZ_CTR')).toEqual([])
    expect(centreAreaIds(real, 'CTR')).toEqual([])
    expect(centreAreaIds(real, '')).toEqual([])
  })

  it('does not care about the case of the callsign', () => {
    expect(centreAreaIds(real, 'lon_c_ctr')).toEqual(['EGTT-C'])
  })
})

describe('approachArea on the bundled file', () => {
  it('finds an approach and a departure by their suffix, from the one prefix', () => {
    expect(approachArea(real, 'LAX_APP')?.name).toBe('SoCal Approach')
    expect(approachArea(real, 'LAX_DEP')?.name).toBe('SoCal Departure')
  })

  it('finds Heathrow’s and Gatwick’s directors by the airport’s code', () => {
    expect(approachArea(real, 'EGLL_APP')?.name).toBe('Heathrow Director')
    expect(approachArea(real, 'EGKK_APP')?.name).toBe('Gatwick Director')
  })

  it('has no area for an airport that has none, and never draws a made-up one', () => {
    expect(approachArea(real, 'LKPR_APP')).toBeNull()
    expect(approachArea(real, 'LKPR_D_APP')).toBeNull()
    expect(approachArea(real, 'EGLL_TWR')).toBeNull()
  })
})

describe('the rules on small files', () => {
  const data = parseAreaData(file()) as AreaData

  it('takes the longer prefix first, then the shorter ("LAX_U" before "LAX")', () => {
    expect(approachArea(data, 'LAX_U_APP')?.id).toBe('LAXU')
    expect(approachArea(data, 'LAX_E_APP')?.id).toBe('SCT')
    expect(approachArea(data, 'SAN_APP')?.name).toBe('SoCal Approach')
  })

  it('does not use an approach area for a departure that has none of its own', () => {
    expect(approachArea(data, 'SAN_DEP')).toBeNull()
  })

  it('names the areas an upper area covers, leaving out one the data has no shape for', () => {
    expect(centreAreaIds(data, 'FRA_CTR')).toEqual(['LFFF', 'LFRR'])
  })

  it('places a label the file does not place at the middle of the shape', () => {
    expect(data.firs.get('EGTT-C')?.at).toEqual([0.5, 0.5])
    expect(approachArea(data, 'LAX_DEP')?.at).toEqual([0.5, 0.5])
  })
})

describe('parseAreaData on damaged files', () => {
  it.each([
    ['not JSON', 'nope'],
    ['a list', '[]'],
    ['null', 'null'],
    ['no sources', '{}'],
    ['nothing', '']
  ])('is null for %s', (_name, text) => {
    expect(parseAreaData(text)).toBeNull()
  })

  it('drops an area whose shape is not a polygon, keeping the rest', () => {
    const bad = {
      firs: {
        EGTT: {
          name: 'London',
          at: [-1, 52],
          coordinates: [
            [
              [
                [0, 0],
                [1, 1]
              ]
            ]
          ]
        },
        CZVR: { name: 'Vancouver', at: [-123, 49], coordinates: SQUARE }
      }
    }
    const data = parseAreaData(file(bad)) as AreaData
    expect([...data.firs.keys()]).toEqual(['CZVR'])
  })

  it('drops an area with a point off the Earth, a coordinate that is text, or no name', () => {
    const ring = (point: unknown): unknown => [[[[0, 0], [1, 0], point, [0, 1], [0, 0]]]]
    const bad = {
      firs: {
        A: { name: 'Off Earth', coordinates: ring([200, 0]) },
        B: { name: 'Text', coordinates: ring(['1', '2']) },
        C: { coordinates: SQUARE },
        D: { name: 'Fine', coordinates: SQUARE }
      }
    }
    const data = parseAreaData(file(bad)) as AreaData
    expect([...data.firs.keys()]).toEqual(['D'])
  })

  it('ignores a table that is not one, and prefixes that are not text', () => {
    const data = parseAreaData(
      file({ prefixes: { LON: 5, X: 'EGTT' }, uirs: 'many', approaches: 'many' })
    ) as AreaData
    expect([...data.prefixes.keys()]).toEqual(['X'])
    expect(data.uirs.size).toBe(0)
    expect(data.approaches.size).toBe(0)
  })

  it('stops reading shapes when the file claims more points than it may', () => {
    const points = Array.from({ length: 600_000 }, (_, i) => [(i % 100) / 10, (i % 50) / 10])
    const big = (): unknown => ({ name: 'Big', coordinates: [[[...points, points[0]]]] })
    const data = parseAreaData(file({ firs: { A: big(), B: big(), C: big() } })) as AreaData
    // Only what fits the budget is kept, so a runaway file cannot fill the heap.
    expect(data.firs.size).toBeLessThan(3)
  })
})
