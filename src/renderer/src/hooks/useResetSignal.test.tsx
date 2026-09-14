import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useResetSignal } from './useResetSignal'

describe('useResetSignal', () => {
  it('does not call onReset on initial mount', () => {
    const onReset = vi.fn()
    renderHook(({ signal }) => useResetSignal(signal, onReset), { initialProps: { signal: 1 } })
    expect(onReset).not.toHaveBeenCalled()
  })

  it('calls onReset when the signal changes after mount', () => {
    const onReset = vi.fn()
    const { rerender } = renderHook(({ signal }) => useResetSignal(signal, onReset), {
      initialProps: { signal: 1 }
    })

    rerender({ signal: 2 })

    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('calls onReset again for each subsequent change', () => {
    const onReset = vi.fn()
    const { rerender } = renderHook(({ signal }) => useResetSignal(signal, onReset), {
      initialProps: { signal: 1 }
    })

    rerender({ signal: 2 })
    rerender({ signal: 3 })

    expect(onReset).toHaveBeenCalledTimes(2)
  })

  it('does not call onReset on a re-render that does not change the signal', () => {
    const onReset = vi.fn()
    const { rerender } = renderHook(({ signal }) => useResetSignal(signal, onReset), {
      initialProps: { signal: 1 }
    })

    rerender({ signal: 1 })

    expect(onReset).not.toHaveBeenCalled()
  })
})
