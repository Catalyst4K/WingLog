import { describe, expect, it, vi } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { setSourceData } from './map-source'

const EMPTY = { type: 'FeatureCollection' as const, features: [] }

function fakeMap(setData?: ReturnType<typeof vi.fn>): MapLibreMap {
  return { getSource: () => (setData ? { setData } : undefined) } as unknown as MapLibreMap
}

describe('setSourceData', () => {
  it("sets the source's data", () => {
    const setData = vi.fn().mockResolvedValue(undefined)
    setSourceData(fakeMap(setData), 'taxi-route-trace', EMPTY)
    expect(setData).toHaveBeenCalledWith(EMPTY)
  })

  it('does nothing when the map has no such source', () => {
    expect(() => setSourceData(fakeMap(), 'missing', EMPTY)).not.toThrow()
  })

  it('handles the rejection when the map is torn down mid-update', async () => {
    const rejected = Promise.reject(new Error('map removed'))
    const handled = vi.spyOn(rejected, 'catch')
    setSourceData(fakeMap(vi.fn().mockReturnValue(rejected)), 'vfr-airfields', EMPTY)
    expect(handled).toHaveBeenCalledOnce()
    // The handler itself settles without throwing.
    await expect(handled.mock.results[0]?.value).resolves.toBeUndefined()
  })
})
