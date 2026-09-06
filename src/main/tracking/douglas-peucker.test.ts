import { describe, expect, it } from 'vitest'
import { perpendicularDistance2D, simplifyIndices } from './douglas-peucker'

describe('simplifyIndices', () => {
  it('keeps everything when there are fewer than 3 points', () => {
    expect(simplifyIndices([], 10, perpendicularDistance2D)).toEqual(new Set())
    expect(simplifyIndices([{ x: 0, y: 0 }], 10, perpendicularDistance2D)).toEqual(new Set([0]))
    expect(
      simplifyIndices(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 }
        ],
        10,
        perpendicularDistance2D
      )
    ).toEqual(new Set([0, 1]))
  })

  it('collapses a perfectly straight line to just its endpoints', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }))
    expect(simplifyIndices(points, 0.01, perpendicularDistance2D)).toEqual(new Set([0, 49]))
  })

  it('keeps a real corner point that deviates beyond tolerance', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 10 }, // sharp turn
      { x: 15, y: 0 },
      { x: 20, y: 0 }
    ]
    const kept = simplifyIndices(points, 1, perpendicularDistance2D)
    expect(kept.has(2)).toBe(true)
  })

  it('drops a point whose deviation is within tolerance', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 0.5 }, // tiny wobble
      { x: 10, y: 0 }
    ]
    const kept = simplifyIndices(points, 5, perpendicularDistance2D)
    expect(kept).toEqual(new Set([0, 2]))
  })

  it('always keeps the first and last point regardless of tolerance', () => {
    const points = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 0 }))
    const kept = simplifyIndices(points, 1000, perpendicularDistance2D)
    expect(kept.has(0)).toBe(true)
    expect(kept.has(19)).toBe(true)
  })
})
