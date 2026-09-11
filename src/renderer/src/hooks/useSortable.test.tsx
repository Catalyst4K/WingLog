import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSortable } from './useSortable'

interface Row {
  name: string
  age: number
}

const ROWS: Row[] = [
  { name: 'Charlie', age: 40 },
  { name: 'Alice', age: 20 },
  { name: 'Bob', age: 30 }
]

const COMPARATORS = {
  name: (a: Row, b: Row) => a.name.localeCompare(b.name),
  age: (a: Row, b: Row) => a.age - b.age
}

describe('useSortable', () => {
  it('sorts by the default key/direction on first render', () => {
    const { result } = renderHook(() => useSortable<Row, 'name' | 'age'>(ROWS, COMPARATORS, 'name'))
    expect(result.current.sortedRows.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Charlie'])
    expect(result.current.sortKey).toBe('name')
    expect(result.current.sortDir).toBe('asc')
  })

  it('honors a non-default initial direction', () => {
    const { result } = renderHook(() => useSortable<Row, 'name' | 'age'>(ROWS, COMPARATORS, 'age', 'desc'))
    expect(result.current.sortedRows.map((r) => r.age)).toEqual([40, 30, 20])
  })

  it('reverses direction when the same header is clicked again', () => {
    const { result } = renderHook(() => useSortable<Row, 'name' | 'age'>(ROWS, COMPARATORS, 'name'))
    act(() => result.current.handleSort('name'))
    expect(result.current.sortDir).toBe('desc')
    expect(result.current.sortedRows.map((r) => r.name)).toEqual(['Charlie', 'Bob', 'Alice'])
  })

  it('switches to a different key ascending when a different header is clicked', () => {
    const { result } = renderHook(() => useSortable<Row, 'name' | 'age'>(ROWS, COMPARATORS, 'name'))
    act(() => result.current.handleSort('name')) // now desc
    act(() => result.current.handleSort('age')) // switch key — resets to asc
    expect(result.current.sortKey).toBe('age')
    expect(result.current.sortDir).toBe('asc')
    expect(result.current.sortedRows.map((r) => r.age)).toEqual([20, 30, 40])
  })

  it('does not mutate the original rows array', () => {
    const { result } = renderHook(() => useSortable<Row, 'name' | 'age'>(ROWS, COMPARATORS, 'name'))
    expect(ROWS.map((r) => r.name)).toEqual(['Charlie', 'Alice', 'Bob'])
    expect(result.current.sortedRows).not.toBe(ROWS)
  })
})
