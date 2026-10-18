/** A small binary min-heap of (state, cost) pairs: the taxi trace's search queue (taxi-route-trace.ts). */
import { itemAt } from '@shared/item-at'

/** A small binary min-heap of (state, cost) — VHHH's real network is ~4,400 points, well
 *  past what a linear-scan "queue" handles comfortably per clearance. */
export class MinQueue {
  private readonly items: [number, number][] = []

  get size(): number {
    return this.items.length
  }

  /**
   * @param state The state.
   * @param cost Its cost.
   */
  push(state: number, cost: number): void {
    const items = this.items
    items.push([state, cost])
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.swapIfLess(i, parent)) break
      i = parent
    }
  }

  /**
   * @returns The cheapest (state, cost), removed.
   * @throws RangeError if the queue is empty.
   */
  pop(): [number, number] {
    const items = this.items
    const top = itemAt(items, 0, 'queue item')
    const end = itemAt(items, items.length - 1, 'queue item')
    items.pop()
    if (items.length > 0) {
      items[0] = end
      let i = 0
      for (;;) {
        const left = i * 2 + 1
        const right = left + 1
        let smallest = i
        if (left < items.length && this.costAt(left) < this.costAt(smallest)) smallest = left
        if (right < items.length && this.costAt(right) < this.costAt(smallest)) smallest = right
        if (smallest === i) break
        this.swap(smallest, i)
        i = smallest
      }
    }
    return top
  }

  /**
   * @param i An index in the heap.
   * @returns That item's cost.
   */
  private costAt(i: number): number {
    return itemAt(this.items, i, 'queue item')[1]
  }

  /**
   * @param a One index.
   * @param b The other.
   */
  private swap(a: number, b: number): void {
    const itemA = itemAt(this.items, a, 'queue item')
    this.items[a] = itemAt(this.items, b, 'queue item')
    this.items[b] = itemA
  }

  /**
   * Swaps a child up past its parent when the child costs less.
   *
   * @param child The child's index.
   * @param parent The parent's index.
   * @returns True if they were swapped.
   */
  private swapIfLess(child: number, parent: number): boolean {
    if (this.costAt(parent) <= this.costAt(child)) return false
    this.swap(parent, child)
    return true
  }
}
