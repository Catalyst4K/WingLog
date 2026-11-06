import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  addFixSymbols,
  FIX_APPROACH_ICON_ID,
  FIX_ENROUTE_ICON_ID,
  FIX_PROCEDURE_ICON_ID
} from './fix-symbols'
import { mapPalette } from './map-palette'

function fakeMap(has: string[] = []) {
  return { hasImage: vi.fn((id: string) => has.includes(id)), addImage: vi.fn() }
}

function fakeContext() {
  return {
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({ width: w, height: h })),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineJoin: ''
  }
}

describe('addFixSymbols', () => {
  afterEach(() => vi.restoreAllMocks())

  it('adds the three symbols as SDF images at twice their size, each sized for what it marks', () => {
    const context = fakeContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
    const map = fakeMap()
    addFixSymbols(map as unknown as MapLibreMap)
    const added = map.addImage.mock.calls.map(([id, image, options]) => ({ id, image, options }))
    expect(added.map((a) => a.id)).toEqual([FIX_ENROUTE_ICON_ID, FIX_PROCEDURE_ICON_ID, FIX_APPROACH_ICON_ID])
    expect(added.every((a) => a.options.sdf === true && a.options.pixelRatio === 2)).toBe(true)
    // En route is the smallest, a procedure fix larger.
    const widths = Object.fromEntries(added.map((a) => [a.id, a.image.width]))
    expect(widths[FIX_ENROUTE_ICON_ID]).toBeLessThan(widths[FIX_PROCEDURE_ICON_ID])
    // All three are outlines, none filled: an en route fix is a circle, a SID or STAR fix a hexagon (six corners, so five lines and a
    // close), an approach fix a triangle (two lines and a close).
    expect(context.stroke).toHaveBeenCalledTimes(3)
    expect(context.fill).not.toHaveBeenCalled()
    expect(context.arc).toHaveBeenCalledTimes(1)
    expect(context.closePath).toHaveBeenCalledTimes(2)
    expect(context.lineTo).toHaveBeenCalledTimes(5 + 2)
    expect(context.strokeStyle).toBe('#ffffff')
  })

  it('skips a symbol the map already has', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeContext() as never)
    const map = fakeMap([FIX_ENROUTE_ICON_ID, FIX_PROCEDURE_ICON_ID])
    addFixSymbols(map as unknown as MapLibreMap)
    expect(map.addImage).toHaveBeenCalledTimes(1)
    expect(map.addImage.mock.calls[0]?.[0]).toBe(FIX_APPROACH_ICON_ID)
  })

  it('adds nothing where there is no 2D canvas', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const map = fakeMap()
    addFixSymbols(map as unknown as MapLibreMap)
    expect(map.addImage).not.toHaveBeenCalled()
  })
})

describe('mapPalette', () => {
  it('has the plan in magenta and the flown track in ink, in both themes', () => {
    expect(mapPalette(false)).toMatchObject({ plan: '#a61e6b', ink: '#1c1b19', atc: '#2a62a3' })
    expect(mapPalette(true)).toMatchObject({ plan: '#e26aae', ink: '#ece9e1', atc: '#7fb0e8' })
  })

  it('gives the cleared taxi route a dark edge on the light map only', () => {
    expect(mapPalette(false).taxiEdgeOpacity).toBeGreaterThan(0)
    expect(mapPalette(true).taxiEdgeOpacity).toBe(0)
    expect(mapPalette(false).taxi).toBe('#f2c200')
    expect(mapPalette(true).taxi).toBe('#facc15')
  })
})
