import { useState } from 'react'

export type SortDir = 'asc' | 'desc'

/**
 * Click-to-sort table state, shared by Logbook and Fleet. Same header click twice reverses
 * direction; clicking a different header switches to it ascending — mirrors how every
 * spreadsheet/file-manager header sort works, so no explicit UI hint is needed.
 */
export function useSortable<TRow, TKey extends string>(
  rows: TRow[],
  comparators: Record<TKey, (a: TRow, b: TRow) => number>,
  defaultKey: TKey,
  defaultDir: SortDir = 'asc'
): {
  sortKey: TKey
  sortDir: SortDir
  sortedRows: TRow[]
  handleSort: (key: TKey) => void
} {
  const [sortKey, setSortKey] = useState<TKey>(defaultKey)
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir)

  function handleSort(key: TKey): void {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sortedRows = [...rows].sort((a, b) => {
    const cmp = comparators[sortKey](a, b)
    return sortDir === 'asc' ? cmp : -cmp
  })

  return { sortKey, sortDir, sortedRows, handleSort }
}
