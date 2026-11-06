import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { NARROW_WINDOW_PX, useNarrowWindow } from './use-narrow-window'

/** A window whose width can be changed, telling every listener, as matchMedia does. */
function stubWindow(initialWidth: number): { resize: (width: number) => void } {
  let width = initialWidth
  const listeners = new Set<() => void>()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return width < NARROW_WINDOW_PX
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)
    }))
  )
  return {
    resize: (next) => {
      width = next
      listeners.forEach((listener) => listener())
    }
  }
}

describe('useNarrowWindow', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is true below the width and false from it', () => {
    stubWindow(NARROW_WINDOW_PX - 1)
    expect(renderHook(() => useNarrowWindow()).result.current).toBe(true)
    stubWindow(NARROW_WINDOW_PX)
    expect(renderHook(() => useNarrowWindow()).result.current).toBe(false)
  })

  it('follows the window as it is resized', () => {
    const screen = stubWindow(1200)
    const { result } = renderHook(() => useNarrowWindow())
    expect(result.current).toBe(false)
    act(() => screen.resize(600))
    expect(result.current).toBe(true)
    act(() => screen.resize(1000))
    expect(result.current).toBe(false)
  })

  it('is false where the window cannot say', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(renderHook(() => useNarrowWindow()).result.current).toBe(false)
  })
})
