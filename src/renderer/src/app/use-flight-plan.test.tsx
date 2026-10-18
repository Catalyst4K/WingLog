import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ProcedureSelection, WingLogApi } from '@shared/ipc'
import { useFlightPlan } from './use-app-state'

const CHOSEN: ProcedureSelection = {
  departureRunway: '27R',
  sidIdent: 'BPK7F',
  sidTransition: null,
  starIdent: 'SIER7B',
  starTransition: null,
  approachIdent: 'ILS 27L',
  approachTransition: null,
  arrivalIcao: null
}

/** Installs a window.winglog that lets the test push procedure selections as the PC would. */
function withWinglog() {
  let announce: (selection: ProcedureSelection | null) => void = () => undefined
  const unsubscribe = vi.fn()
  window.winglog = {
    dispatchGetInProgressFlight: vi.fn().mockResolvedValue(null),
    onTrackingPoint: vi.fn(() => () => undefined),
    onProcedureSelection: vi.fn((listener) => {
      announce = listener
      return unsubscribe
    })
  } as unknown as WingLogApi
  return { announce: (selection: ProcedureSelection | null) => announce(selection), unsubscribe }
}

describe('useFlightPlan: procedures chosen on a second screen', () => {
  afterEach(() => vi.restoreAllMocks())

  it('takes a selection the PC announces, so Dispatch and Track follow a phone', async () => {
    const pc = withWinglog()
    const { result } = renderHook(() => useFlightPlan())
    await act(async () => undefined)
    act(() => pc.announce(CHOSEN))
    expect(result.current.procedureSelection).toEqual(CHOSEN)
  })

  it('ignores an announcement of nothing, and keeps the same selection (no re-render) for one it already has', async () => {
    const pc = withWinglog()
    const { result } = renderHook(() => useFlightPlan())
    await act(async () => undefined)
    act(() => pc.announce(CHOSEN))
    const before = result.current.procedureSelection
    act(() => pc.announce(null))
    expect(result.current.procedureSelection).toBe(before)
    act(() => pc.announce({ ...CHOSEN }))
    expect(result.current.procedureSelection).toBe(before)
  })

  it('stops listening when the app goes away', async () => {
    const pc = withWinglog()
    const { unmount } = renderHook(() => useFlightPlan())
    await act(async () => undefined)
    unmount()
    expect(pc.unsubscribe).toHaveBeenCalled()
  })
})
