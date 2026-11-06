import { describe, expect, it, vi } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { recolourBasemap } from './basemap-style'

// The shapes and ids are those of OpenFreeMap's `positron` and `dark` styles (fetched 2026-11-06).
const LAYERS = [
  { id: 'background', type: 'background' },
  { id: 'park', type: 'fill' },
  { id: 'water', type: 'fill' },
  { id: 'landcover_ice_shelf', type: 'fill' },
  { id: 'landcover_wood', type: 'fill' },
  { id: 'landuse_residential', type: 'fill' },
  { id: 'building', type: 'fill' },
  { id: 'waterway', type: 'line' },
  { id: 'highway_minor', type: 'line' },
  { id: 'label_city', type: 'symbol', layout: { 'text-field': ['get', 'name'] } },
  { id: 'highway-shield-us-interstate', type: 'symbol', layout: { 'icon-image': 'shield' } }
]

function fakeMap(layers: unknown[] = LAYERS) {
  return {
    getStyle: vi.fn(() => ({ layers })),
    setPaintProperty: vi.fn()
  }
}

describe('recolourBasemap', () => {
  it('recolours the ground, water, land use and place labels, and leaves roads and buildings as drawn (light)', () => {
    const map = fakeMap()
    recolourBasemap(map as unknown as MapLibreMap, false)
    const set = map.setPaintProperty.mock.calls.map(([id, name, value]) => `${id} ${name} ${value}`)
    expect(set).toEqual([
      'background background-color #efede6',
      'park fill-color #e6e3da',
      'water fill-color #dce6ec',
      'landcover_wood fill-color #e6e3da',
      'landuse_residential fill-color #e6e3da',
      'waterway line-color #dce6ec',
      'label_city text-color #5e594f',
      'label_city text-halo-color #f3f1eb'
    ])
  })

  it('uses the dark palette in the dark theme', () => {
    const map = fakeMap()
    recolourBasemap(map as unknown as MapLibreMap, true)
    expect(map.setPaintProperty).toHaveBeenCalledWith('background', 'background-color', '#1d1d1b')
    expect(map.setPaintProperty).toHaveBeenCalledWith('water', 'fill-color', '#121416')
    expect(map.setPaintProperty).toHaveBeenCalledWith('label_city', 'text-color', '#a29e94')
  })

  it('leaves the ice layers alone', () => {
    const map = fakeMap()
    recolourBasemap(map as unknown as MapLibreMap, false)
    expect(map.setPaintProperty.mock.calls.some(([id]) => id === 'landcover_ice_shelf')).toBe(false)
  })

  it('carries on past a layer the map refuses, and does nothing when the style cannot be read', () => {
    const map = fakeMap()
    map.setPaintProperty.mockImplementationOnce(() => {
      throw new Error('no such layer')
    })
    expect(() => recolourBasemap(map as unknown as MapLibreMap, false)).not.toThrow()
    expect(map.setPaintProperty.mock.calls.length).toBeGreaterThan(1)
    const unreadable = {
      getStyle: () => {
        throw new Error('style not loaded')
      },
      setPaintProperty: vi.fn()
    }
    expect(() => recolourBasemap(unreadable as unknown as MapLibreMap, false)).not.toThrow()
    expect(unreadable.setPaintProperty).not.toHaveBeenCalled()
  })
})
