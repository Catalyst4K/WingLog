import { describe, expect, it, vi } from 'vitest'
import { lazy, resetLazyValues } from './lazy'

describe('lazy', () => {
  it('loads once, on first call, and keeps the value', () => {
    const load = vi.fn(() => ({ rows: 3 }))
    const value = lazy(load)
    expect(load).not.toHaveBeenCalled()
    const first = value()
    expect(value()).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps a falsy value without loading again', () => {
    const load = vi.fn(() => null)
    const value = lazy(load)
    value()
    value()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('tries again after a load that threw', () => {
    const load = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('not yet')
      })
      .mockReturnValue(7)
    const value = lazy(load)
    expect(() => value()).toThrow('not yet')
    expect(value()).toBe(7)
  })

  it('loads again after resetLazyValues', () => {
    const load = vi.fn(() => 1)
    const value = lazy(load)
    value()
    resetLazyValues()
    value()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
