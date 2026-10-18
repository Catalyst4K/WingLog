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
  it('logs a failed update to main.log, with the source it was for', async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { winglog: { appLogRendererError: log } })
    try {
      const setData = vi.fn().mockRejectedValue(new Error('worker failed'))
      setSourceData(
        { getSource: () => ({ id: 'vfr-airfields', setData }) } as unknown as MapLibreMap,
        'vfr-airfields',
        EMPTY
      )
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith('map: update source vfr-airfields', 'worker failed')
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
