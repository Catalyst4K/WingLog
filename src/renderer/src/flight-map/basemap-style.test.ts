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
      'background background-color #f1eee6',
      'park fill-color #d2e2c0',
      'water fill-color #b4d1e6',
      'landcover_wood fill-color #d2e2c0',
      'landuse_residential fill-color #e5e0d2',
      'waterway line-color #b4d1e6',
      'label_city text-color #5e594f',
      'label_city text-halo-color #ebe8de'
    ])
  })

  it('uses the dark palette in the dark theme', () => {
    const map = fakeMap()
    recolourBasemap(map as unknown as MapLibreMap, true)
    expect(map.setPaintProperty).toHaveBeenCalledWith('background', 'background-color', '#1e1e1b')
    expect(map.setPaintProperty).toHaveBeenCalledWith('water', 'fill-color', '#17314a')
    expect(map.setPaintProperty).toHaveBeenCalledWith('label_city', 'text-color', '#a29e94')
  })

  it('paints the dark style’s roads, runways and buildings by id, so they read on the dark ground, and none of that in the light theme', () => {
    const layers = [
      { id: 'highway_minor', type: 'line' },
      { id: 'highway_motorway_inner', type: 'line' },
      { id: 'building', type: 'fill' },
      { id: 'aeroway-runway', type: 'line' }
    ]
    const dark = fakeMap(layers)
    recolourBasemap(dark as unknown as MapLibreMap, true)
    expect(dark.setPaintProperty.mock.calls.map(([id, name, value]) => `${id} ${name} ${value}`)).toEqual([
      'highway_minor line-color #3d3c37',
      'highway_motorway_inner line-color #7a766b',
      'building fill-color #262521',
      'aeroway-runway line-color #6a675f'
    ])
    const light = fakeMap(layers)
    recolourBasemap(light as unknown as MapLibreMap, false)
    expect(light.setPaintProperty).not.toHaveBeenCalled()
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
