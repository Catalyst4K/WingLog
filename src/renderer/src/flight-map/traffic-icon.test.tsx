import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { addTrafficIcon, TRAFFIC_ICON_ID } from './traffic-icon'

function fakeMap(has = false) {
  return { hasImage: vi.fn(() => has), addImage: vi.fn() }
}

describe('addTrafficIcon', () => {
  afterEach(() => vi.restoreAllMocks())

  it('draws the aircraft outline in white at twice the size and adds it once as an SDF image', () => {
    const fill = vi.fn()
    const scale = vi.fn()
    const image = { width: 48, height: 48 }
    const context = { scale, fill, fillStyle: '', getImageData: vi.fn(() => image) }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
    vi.stubGlobal('Path2D', class {})
    const map = fakeMap()
    addTrafficIcon(map as unknown as MapLibreMap)
    expect(context.fillStyle).toBe('#ffffff')
    expect(scale).toHaveBeenCalledWith(2, 2)
    expect(fill).toHaveBeenCalledTimes(1)
    expect(map.addImage).toHaveBeenCalledWith(TRAFFIC_ICON_ID, image, { sdf: true, pixelRatio: 2 })
    vi.unstubAllGlobals()
  })

  it('does not add it twice', () => {
    const map = fakeMap(true)
    addTrafficIcon(map as unknown as MapLibreMap)
    expect(map.addImage).not.toHaveBeenCalled()
  })

  it('adds nothing where there is no 2D canvas', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const map = fakeMap()
    addTrafficIcon(map as unknown as MapLibreMap)
    expect(map.addImage).not.toHaveBeenCalled()
  })
})
