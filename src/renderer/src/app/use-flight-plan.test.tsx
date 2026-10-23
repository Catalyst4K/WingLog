import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { DispatchOfp, ProcedureSelection, WingLogApi } from '@shared/ipc'
import { emptyProcedureSelection } from '@shared/procedure-selection'
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

/** A fetched plan: only what the flight plan state reads. */
const OFP = { ofpId: 'OFP-1', ofpJson: '{}' } as unknown as DispatchOfp

/**
 * Installs a window.winglog that lets the test push procedure selections as the main process would, and say what it holds when the window
 * asks.
 *
 * @param held What the main process holds for the flight shown, when the window asks.
 * @returns The way to announce a selection, and what the window sent and listened to.
 */
function withWinglog(held: ProcedureSelection | null = null) {
  let announce: (selection: ProcedureSelection | null) => void = () => undefined
  const unsubscribe = vi.fn()
  const set = vi.fn().mockResolvedValue(undefined)
  window.winglog = {
    dispatchGetInProgressFlight: vi.fn().mockResolvedValue(null),
    onTrackingPoint: vi.fn(() => () => undefined),
    trackingGetProcedureSelection: vi.fn().mockResolvedValue(held),
    trackingSetProcedureSelection: set,
    onProcedureSelection: vi.fn((listener) => {
      announce = listener
      return unsubscribe
    })
  } as unknown as WingLogApi
  return { announce: (selection: ProcedureSelection | null) => announce(selection), unsubscribe, set }
}

describe('useFlightPlan: procedures chosen on a second screen', () => {
  afterEach(() => vi.restoreAllMocks())

  it('takes a selection the main process announces, so Dispatch and Track follow a phone', async () => {
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

  it('shows the choice the main process already holds when the window opens (a restart, or a flight chosen on a phone)', async () => {
    withWinglog(CHOSEN)
    const { result } = renderHook(() => useFlightPlan())
    await act(async () => undefined)
    expect(result.current.procedureSelection).toEqual(CHOSEN)
  })
})

describe('useFlightPlan: sending a change to the main process', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends a change for the flight shown, once, and takes it as the choice', async () => {
    const pc = withWinglog()
    const { result } = renderHook(() => useFlightPlan())
    await act(async () => undefined)
    act(() => result.current.setProcedureSelection(CHOSEN))
    expect(pc.set).toHaveBeenCalledTimes(1)
    expect(pc.set).toHaveBeenCalledWith(CHOSEN)
    expect(result.current.procedureSelection).toEqual(CHOSEN)
  })

  it('sends nothing for a change that changes nothing', async () => {
    const pc = withWinglog()
    const { result } = renderHook(() => useFlightPlan())
    await act(async () => undefined)
    act(() => result.current.setProcedureSelection(emptyProcedureSelection()))
    expect(pc.set).not.toHaveBeenCalled()
  })

  it('chains changes made in the same moment, each built on the one before (an accepted clearance after a pick)', async () => {
    const pc = withWinglog()
    const { result } = renderHook(() => useFlightPlan())
    await act(async () => undefined)
    act(() => {
      result.current.setProcedureSelection((prev) => ({ ...prev, sidIdent: 'BPK7F' }))
      result.current.setProcedureSelection((prev) => ({ ...prev, starIdent: 'SIER7B' }))
    })
    expect(result.current.procedureSelection).toMatchObject({ sidIdent: 'BPK7F', starIdent: 'SIER7B' })
    expect(pc.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ sidIdent: 'BPK7F', starIdent: 'SIER7B' })
    )
  })

  it("keeps a plan that is not a flight yet to itself: nothing is sent while it is drafted, and the flight shown's announcements do not change it", async () => {
    const pc = withWinglog()
    const { result } = renderHook(() => useFlightPlan())
    await act(async () => undefined)
    act(() => result.current.onDispatchOfpChange(OFP))
    act(() => result.current.setProcedureSelection({ ...emptyProcedureSelection(), sidIdent: 'DRAFT1A' }))
    expect(pc.set).not.toHaveBeenCalled()
    act(() => pc.announce(CHOSEN))
    expect(result.current.procedureSelection.sidIdent).toBe('DRAFT1A')
  })

  it('sends changes once the plan has been turned into a flight, and follows the flight shown again', async () => {
    const pc = withWinglog()
    const { result } = renderHook(() => useFlightPlan())
    await act(async () => undefined)
    act(() => result.current.onDispatchOfpChange(OFP))
    act(() => result.current.setProcedureSelection({ ...emptyProcedureSelection(), sidIdent: 'DRAFT1A' }))
    // Fly: the plan is saved as a flight.
    act(() => result.current.setDispatchedOfpId(OFP.ofpId))
    await act(async () => undefined)
    act(() => result.current.setProcedureSelection({ ...emptyProcedureSelection(), sidIdent: 'SAVED2B' }))
    expect(pc.set).toHaveBeenCalledWith(expect.objectContaining({ sidIdent: 'SAVED2B' }))
    act(() => pc.announce(CHOSEN))
    expect(result.current.procedureSelection).toEqual(CHOSEN)
  })

  it('swallows a failure to send, rather than crashing', async () => {
    const pc = withWinglog()
    pc.set.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useFlightPlan())
    await act(async () => undefined)
    act(() => result.current.setProcedureSelection(CHOSEN))
    await act(async () => undefined)
    expect(result.current.procedureSelection).toEqual(CHOSEN)
  })
})
