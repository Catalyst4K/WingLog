import { describe, expect, it } from 'vitest'
import { MinQueue } from './min-queue'

describe('MinQueue', () => {
  it('pops states cheapest first, whatever order they went in', () => {
    const queue = new MinQueue()
    for (const [state, cost] of [
      [1, 50],
      [2, 10],
      [3, 30],
      [4, 20],
      [5, 40]
    ] as [number, number][])
      queue.push(state, cost)
    expect(queue.size).toBe(5)
    const order: number[] = []
    while (queue.size > 0) order.push(queue.pop()[0])
    expect(order).toEqual([2, 4, 3, 5, 1])
  })

  it('throws on an empty pop', () => {
    expect(() => new MinQueue().pop()).toThrow(RangeError)
  })
})
