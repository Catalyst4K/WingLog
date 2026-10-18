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
    expect(result.current).toMatchObject({
      weightUnit: 'lb',
      altitudeUnit: 'm',
      windSpeedUnit: 'mps',
      gsxRemote: true,
      beyondAtc: true
    })
  })

  it("reads how the PC looks (language, theme, map language), and ignores anything it doesn't know", async () => {
    const looks = {
      weightUnit: 'kg',
      altitudeUnit: 'ft',
      windSpeedUnit: 'kt',
      appLanguage: 'de',
      systemLocale: 'de-DE',
      theme: 'dark',
      mapLanguage: 'fr'
    }
    const { link } = fakeLink({ ...ANSWERS, 'settings.display': () => Promise.resolve(looks) })
    const { result } = renderHook(() => usePcSettings(link))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current).toMatchObject({
      appLanguage: 'de',
      systemLocale: 'de-DE',
      theme: 'dark',
      mapLanguage: 'fr'
    })

    const junk = { ...looks, appLanguage: 'klingon', systemLocale: 42, theme: 'neon', mapLanguage: 'xx' }
    const other = fakeLink({ ...ANSWERS, 'settings.display': () => Promise.resolve(junk) })
    const { result: safe } = renderHook(() => usePcSettings(other.link))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(safe.current).toMatchObject({ appLanguage: 'system', theme: 'system', mapLanguage: 'en' })
    expect(typeof safe.current.systemLocale).toBe('string')
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
    // It gives up after a few tries (the periodic refresh, every 5 s, is separate).
    await act(() => vi.advanceTimersByTimeAsync(1_600))
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

  it('shows a change made on the PC within a few seconds, and when the page comes back to the front', async () => {
    let units = { weightUnit: 'kg', altitudeUnit: 'ft', windSpeedUnit: 'kt' }
    const { link, asked } = fakeLink({ ...ANSWERS, 'settings.display': () => Promise.resolve(units) })
    const { result } = renderHook(() => usePcSettings(link))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current).toMatchObject({ weightUnit: 'kg', altitudeUnit: 'ft' })

    units = { weightUnit: 'lb', altitudeUnit: 'm', windSpeedUnit: 'mps' }
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(result.current).toMatchObject({ weightUnit: 'lb', altitudeUnit: 'm', windSpeedUnit: 'mps' })

    const before = result.current
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(result.current).toBe(before) // the same answer is not a new object

    units = { weightUnit: 'kg', altitudeUnit: 'hybrid', windSpeedUnit: 'kt' }
    const asks = asked.length
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(asked.length).toBeGreaterThan(asks)
    expect(result.current).toMatchObject({ weightUnit: 'kg', altitudeUnit: 'hybrid' })
  })

  it('stops asking when the page is closed', async () => {
    const { link, asked } = fakeLink(ANSWERS)
    const { unmount } = renderHook(() => usePcSettings(link))
    await act(() => vi.advanceTimersByTimeAsync(0))
    unmount()
    const asks = asked.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(asked.length).toBe(asks)
  })
})
