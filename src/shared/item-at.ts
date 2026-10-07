/** Reading an array item at an index the code already knows is in range, without a `!`. */

/**
 * The item at an index the caller knows is in range: a loop bound, or an index the same data
 * structure handed out. Narrows `T | undefined` with a check instead of a `!` assertion
 * (coding-standards.md §7), so a wrong index fails here, saying what it was, rather than later
 * as a TypeError on `undefined`.
 *
 * @param items The array.
 * @param index The index.
 * @param what What the items are, for the error.
 * @returns The item.
 * @throws RangeError if there is no item at that index.
 */
export function itemAt<T>(items: readonly T[], index: number, what = 'item'): T {
  const item = items[index]
  if (item === undefined) throw new RangeError(`No ${what} at index ${index} (of ${items.length})`)
  return item
}
