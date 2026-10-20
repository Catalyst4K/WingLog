import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { LanFlightSnapshot, ProcedureSelection } from '@shared/ipc'
import type { LiveTopic, PlannedRoute } from '@shared/live'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import type { LanConnection, LanLinkState } from './lan-connection'
import { CONFIRM_MS, MAX_ATTEMPTS } from './selection-sync'
import { useProcedureChoice } from './use-procedure-choice'

const sel = (sidIdent: string | null): ProcedureSelection => ({ ...emptyProcedureSelection(), sidIdent })

const SNAPSHOT = {
  flight: { flightId: 7, selection: sel('OLD1A') },
  trackPoints: []
} as unknown as LanFlightSnapshot

/** A link that can be told a route arrived or the connection changed. */
function fakeLink() {
  let route: PlannedRoute | undefined
  const topicListeners = new Set<() => void>()
  const stateListeners = new Set<(state: LanLinkState) => void>()
  const command = vi.fn()
  const report = vi.fn()
  const link = {
    command,
    report,
    latest: (topic: LiveTopic) => (topic === 'plannedRoute' ? route : undefined),
    subscribe: (_topic: LiveTopic, listener: () => void) => {
      topicListeners.add(listener)
      return () => topicListeners.delete(listener)
    },
    onState: (listener: (state: LanLinkState) => void) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    }
  } as unknown as LanConnection
  return {
    link,
    command,
    report,
    pcSends: (next: PlannedRoute) => {
      route = next
      for (const listener of topicListeners) listener()
    },
    linkBecomes: (state: LanLinkState) => {
      for (const listener of stateListeners) listener(state)
    }
  }
}

describe('useProcedureChoice', () => {
  it('starts on the flight’s own choice, and follows the PC', () => {
    const t = fakeLink()
    const { result } = renderHook(() => useProcedureChoice(t.link, SNAPSHOT))
    expect(result.current.selection.sidIdent).toBe('OLD1A')
    act(() => t.pcSends({ flightId: 7, revision: 1, selection: sel('NEW1Z'), waypoints: [] }))
    expect(result.current.selection.sidIdent).toBe('NEW1Z')
  })

  it('ignores a route built for another flight', () => {
    const t = fakeLink()
    const { result } = renderHook(() => useProcedureChoice(t.link, SNAPSHOT))
    act(() => t.pcSends({ flightId: 8, revision: 1, selection: sel('OTHER'), waypoints: [] }))
    expect(result.current.selection.sidIdent).toBe('OLD1A')
  })

  it('sends a choice that is still waiting the moment the link comes back, and hears a restarted PC count from 1 again', () => {
    const t = fakeLink()
    const { result } = renderHook(() => useProcedureChoice(t.link, SNAPSHOT))
    act(() => t.pcSends({ flightId: 7, revision: 9, selection: sel('OLD1A'), waypoints: [] }))
    act(() => result.current.choose(sel('NEW1Z')))
    expect(t.command).toHaveBeenCalledTimes(1)
    // The link drops and returns (the PC may have restarted): the choice goes again at once.
    act(() => t.linkBecomes('offline'))
    expect(t.command).toHaveBeenCalledTimes(1)
    act(() => t.linkBecomes('connected'))
    expect(t.command).toHaveBeenCalledTimes(2)
    expect(t.command).toHaveBeenLastCalledWith('track.setProcedureSelection', sel('NEW1Z'))
    // The restarted PC confirms at revision 1: heard, though below the 9 seen before.
    act(() => t.pcSends({ flightId: 7, revision: 1, selection: sel('NEW1Z'), waypoints: [] }))
    expect(result.current.selection.sidIdent).toBe('NEW1Z')
    expect(result.current.unconfirmed).toBe(false)
  })

  it('tells the PC when it gives up on a choice, once, and not when the PC confirms it', () => {
    vi.useFakeTimers()
    try {
      const t = fakeLink()
      const { result } = renderHook(() => useProcedureChoice(t.link, SNAPSHOT))
      act(() => result.current.choose(sel('NEW1Z')))
      for (let i = 0; i < MAX_ATTEMPTS; i++) act(() => void vi.advanceTimersByTime(CONFIRM_MS))
      expect(result.current.unconfirmed).toBe(true)
      expect(t.report).toHaveBeenCalledTimes(1)
      expect(t.report).toHaveBeenCalledWith('selection-unconfirmed')

      const confirmed = fakeLink()
      const second = renderHook(() => useProcedureChoice(confirmed.link, SNAPSHOT))
      act(() => second.result.current.choose(sel('NEW1Z')))
      act(() => confirmed.pcSends({ flightId: 7, revision: 1, selection: sel('NEW1Z'), waypoints: [] }))
      for (let i = 0; i < MAX_ATTEMPTS; i++) act(() => void vi.advanceTimersByTime(CONFIRM_MS))
      expect(confirmed.report).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps going when the link is down while a choice is made', () => {
    const t = fakeLink()
    t.command.mockImplementation(() => {
      throw new Error('Not connected')
    })
    const { result } = renderHook(() => useProcedureChoice(t.link, SNAPSHOT))
    act(() => result.current.choose(sel('NEW1Z')))
    expect(result.current.selection.sidIdent).toBe('NEW1Z')
  })
})
