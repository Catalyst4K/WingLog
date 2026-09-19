import { describe, expect, it } from 'vitest'
import { labelExpression, planStyleChanges, type StyleLayerLike } from './map-labels'

// Synthetic fixtures shaped like the two real OpenFreeMap styles, as read on 2026-09-18
// (docs/navdata-notes.md-style spike, recorded in map-language-and-declutter.md): the same
// two-line `name:latin` + `name:nonlatin` text-field everywhere, place layers told apart by
// `source-layer: 'place'`, positron with minzooms and dark without.
const TWO_LINE = [
  'case',
  ['has', 'name:nonlatin'],
  ['concat', ['get', 'name:latin'], '\n', ['get', 'name:nonlatin']],
  ['coalesce', ['get', 'name_en'], ['get', 'name']]
]

function symbol(id: string, sourceLayer: string, extra: Partial<StyleLayerLike> = {}): StyleLayerLike {
  return { id, type: 'symbol', 'source-layer': sourceLayer, layout: { 'text-field': TWO_LINE }, ...extra }
}

const POSITRON: StyleLayerLike[] = [
  { id: 'background', type: 'background' },
  { id: 'road_fill', type: 'fill', 'source-layer': 'transportation' },
  symbol('label_other', 'place', {
    minzoom: 8,
    filter: ['match', ['get', 'class'], ['city', 'continent', 'country', 'state', 'town', 'village'], false, true]
  }),
  symbol('label_village', 'place', { minzoom: 9, filter: ['==', ['get', 'class'], 'village'] }),
  symbol('label_town', 'place', { minzoom: 6, filter: ['==', ['get', 'class'], 'town'] }),
  symbol('label_state', 'place', { minzoom: 5, maxzoom: 8, filter: ['==', ['get', 'class'], 'state'] }),
  symbol('label_city', 'place', {
    minzoom: 3,
    filter: ['all', ['==', ['get', 'class'], 'city'], ['!=', ['get', 'capital'], 2]]
  }),
  symbol('label_country_1', 'place', { maxzoom: 9, filter: ['all', ['==', ['get', 'class'], 'country'], ['==', ['get', 'rank'], 1]] }),
  symbol('water_name_point_label', 'water_name', { minzoom: 0 }),
  symbol('airport', 'aerodrome_label', { minzoom: 11 }),
  symbol('highway-shield-non-us', 'transportation_name', { layout: { 'text-field': ['to-string', ['get', 'ref']] } })
]

const DARK: StyleLayerLike[] = [
  symbol('place_village', 'place', {
    maxzoom: 14,
    filter: ['all', ['match', ['geometry-type'], ['MultiPoint', 'Point'], true, false], ['==', ['get', 'class'], 'village']]
  }),
  symbol('place_suburb', 'place', {
    maxzoom: 15,
    filter: ['all', ['match', ['geometry-type'], ['MultiPoint', 'Point'], true, false], ['==', ['get', 'class'], 'suburb']]
  }),
  symbol('place_other', 'place', {
    filter: [
      'all',
      ['match', ['geometry-type'], ['MultiPoint', 'Point'], true, false],
      ['match', ['get', 'class'], ['hamlet', 'neighbourhood', 'isolated_dwelling'], true, false]
    ]
  }),
  symbol('place_city', 'place', { maxzoom: 14, filter: ['all', ['==', ['get', 'class'], 'city']] })
]

const byId = (changes: ReturnType<typeof planStyleChanges>, id: string): (typeof changes)[number] | undefined =>
  changes.find((c) => c.id === id)

describe('labelExpression', () => {
  it('collapses to a single line preferring the chosen language, then a Latin name, then the native one', () => {
    expect(labelExpression('de')).toEqual(['coalesce', ['get', 'name:de'], ['get', 'name:latin'], ['get', 'name']])
    expect(labelExpression('en')).toEqual([
      'coalesce',
      ['get', 'name:en'],
      ['get', 'name_en'],
      ['get', 'name:latin'],
      ['get', 'name']
    ])
  })

  it('prefers the native (often Cyrillic) name for Russian, and the native name for "local"', () => {
    expect(labelExpression('ru')).toEqual(['coalesce', ['get', 'name:ru'], ['get', 'name'], ['get', 'name:latin']])
    expect(labelExpression('local')).toEqual(['coalesce', ['get', 'name'], ['get', 'name:latin']])
  })
})

describe('planStyleChanges — language', () => {
  it('rewrites every two-line name label (places, water, airports) but nothing else', () => {
    const changes = planStyleChanges(POSITRON, 'es')
    const rewritten = changes.filter((c) => c.textField).map((c) => c.id)
    expect(rewritten).toEqual(
      expect.arrayContaining(['label_other', 'label_village', 'label_town', 'label_state', 'label_city', 'label_country_1', 'water_name_point_label', 'airport'])
    )
    expect(byId(changes, 'label_town')?.textField).toEqual(labelExpression('es'))
    // A road-shield's ref text, a fill and a background carry no two-line name: untouched.
    expect(byId(changes, 'highway-shield-non-us')).toBeUndefined()
    expect(byId(changes, 'road_fill')).toBeUndefined()
    expect(byId(changes, 'background')).toBeUndefined()
  })

  it('switches language by producing a different expression for the same layers', () => {
    const en = planStyleChanges(POSITRON, 'en').find((c) => c.id === 'label_city')?.textField
    const ru = planStyleChanges(POSITRON, 'ru').find((c) => c.id === 'label_city')?.textField
    expect(en).not.toEqual(ru)
  })
})

describe('planStyleChanges — declutter', () => {
  it('raises the minzoom of low-value place classes only, matching by source-layer and filter rather than id', () => {
    const changes = planStyleChanges(POSITRON, 'en')
    expect(byId(changes, 'label_village')?.minzoom).toBe(10) // was 9
    expect(byId(changes, 'label_other')?.minzoom).toBe(10) // the "everything except" bucket, was 8
    expect(byId(changes, 'label_state')?.minzoom).toBe(6) // was 5, still below its maxzoom of 8
    // Towns, cities and countries are never pushed back.
    for (const id of ['label_town', 'label_city', 'label_country_1']) expect(byId(changes, id)?.minzoom).toBeUndefined()
    // Non-place layers keep their zoom range.
    expect(byId(changes, 'airport')?.minzoom).toBeUndefined()
    expect(byId(changes, 'water_name_point_label')?.minzoom).toBeUndefined()
  })

  it('gives the dark style (which has no minzooms at all) sensible floors, including for a class list', () => {
    const changes = planStyleChanges(DARK, 'en')
    expect(byId(changes, 'place_village')?.minzoom).toBe(10)
    expect(byId(changes, 'place_suburb')?.minzoom).toBe(13)
    // hamlet 12 / neighbourhood 13 / isolated_dwelling 13 -> the strictest applies.
    expect(byId(changes, 'place_other')?.minzoom).toBe(13)
    expect(byId(changes, 'place_city')?.minzoom).toBeUndefined()
  })

  it('never raises a layer to or past its own maxzoom, which would hide it entirely', () => {
    const layers = [symbol('label_state', 'place', { minzoom: 3, maxzoom: 6, filter: ['==', ['get', 'class'], 'state'] })]
    expect(planStyleChanges(layers, 'en')[0]?.minzoom).toBeUndefined()
  })

  it('leaves a place layer it cannot classify alone', () => {
    const odd = [symbol('label_x', 'place', { minzoom: 2, filter: ['some', 'unknown', 'shape'] })]
    expect(planStyleChanges(odd, 'en')[0]?.minzoom).toBeUndefined()
    const noFilter = [symbol('label_y', 'place', { minzoom: 2 })]
    expect(planStyleChanges(noFilter, 'en')[0]?.minzoom).toBeUndefined()
  })

  it('still rewrites the text of an unclassifiable place layer, and skips layers with no layout at all', () => {
    expect(planStyleChanges([symbol('label_x', 'place', { filter: ['some', 'shape'] })], 'en')[0]?.textField).toBeDefined()
    expect(planStyleChanges([{ id: 'bare', type: 'symbol' }], 'en')).toEqual([])
  })

  it('returns nothing for an empty style, so a style that changes shape degrades to unchanged', () => {
    expect(planStyleChanges([], 'en')).toEqual([])
  })
})
