import { describe, expect, it } from 'vitest'
import { itemAt } from './item-at'

describe('itemAt', () => {
  it('returns the item at an index in range, falsy items included', () => {
    expect(itemAt(['B8', 'B', 'B10'], 2)).toBe('B10')
    expect(itemAt([0, 1], 0)).toBe(0)
    expect(itemAt([null], 0)).toBeNull()
  })

  it('throws a RangeError naming the items for an index out of range', () => {
    expect(() => itemAt([1, 2], 2, 'route point')).toThrow(new RangeError('No route point at index 2 (of 2)'))
    expect(() => itemAt([], -1)).toThrow(RangeError)
  })
})
