import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { LanConnection, LanLinkState } from './lan-connection'
import { usePcSettings } from './use-pc-settings'

/** A link that answers lookups from a table of functions, as the PC would, and can be told to refuse. */
function fakeLink(answers: Record<string, () => Promise<unknown>>, state: LanLinkState = 'connected') {
  const asked: string[] = []
  const link = {
    state,
    onState: () => () => undefined,
    query: (name: string) => {
      asked.push(name)
      return answers[name]()
    }
  } as unknown as LanConnection
  return { link, asked }
}

const ANSWERS = {
  'settings.display': () => Promise.resolve({ weightUnit: 'lb', altitudeUnit: 'm', windSpeedUnit: 'mps' }),
  'settings.gsxRemote': () => Promise.resolve({ enabled: true }),
  'settings.beyondAtc': () => Promise.resolve({ enabled: true })
}

describe('usePcSettings', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads the units and which add-ons are on, and offers nothing until the link is up', async () => {
    const idle = fakeLink(ANSWERS, 'starting')
    const { result: before } = renderHook(() => usePcSettings(idle.link))
    expect(idle.asked).toEqual([])
    expect(before.current).toMatchObject({ gsxRemote: false, beyondAtc: false })

    const { link } = fakeLink(ANSWERS)
    const { result } = renderHook(() => usePcSettings(link))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current).toEqual({
      weightUnit: 'lb',
      altitudeUnit: 'm',
      windSpeedUnit: 'mps',
      gsxRemote: true,
      beyondAtc: true
    })
  })

  it('asks again when the PC refuses a lookup, so the add-on pages still appear', async () => {
    let refusals = 2
    const { link, asked } = fakeLink({
      ...ANSWERS,
      'settings.gsxRemote': () =>
        refusals-- > 0
          ? Promise.reject(new Error('The PC could not answer'))
          : Promise.resolve({ enabled: true }),
      'settings.beyondAtc': () => Promise.reject(new Error('The PC could not answer'))
    })
    const { result } = renderHook(() => usePcSettings(link))
    await act(() => vi.advanceTimersByTimeAsync(0))
    // The units that did come back are used at once, whatever else was refused.
    expect(result.current).toMatchObject({ weightUnit: 'lb', gsxRemote: false })
    await act(() => vi.advanceTimersByTimeAsync(1500))
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(result.current.gsxRemote).toBe(true)
    // It gives up after a few tries rather than asking for ever.
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    const askedGsx = asked.filter((name) => name === 'settings.gsxRemote').length
    expect(askedGsx).toBeGreaterThanOrEqual(3)
    expect(asked.filter((name) => name === 'settings.beyondAtc')).toHaveLength(4)
    expect(result.current.beyondAtc).toBe(false)
  })

  it('stops asking when the page goes away', async () => {
    const { link, asked } = fakeLink({
      ...ANSWERS,
      'settings.beyondAtc': () => Promise.reject(new Error('refused'))
    })
    const { unmount } = renderHook(() => usePcSettings(link))
    await act(() => vi.advanceTimersByTimeAsync(0))
    unmount()
    const before = asked.length
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(asked).toHaveLength(before)
  })
})
