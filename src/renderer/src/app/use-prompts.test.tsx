import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BeyondAtcState, GsxRemoteMenuState, ProcedureSelection, WingLogApi } from '@shared/ipc'
import { LiveClientContext, type LiveClient } from '../live/LiveClient'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import { useAtcClearancePrompt, useImportantGsxMenu } from './use-prompts'

/** A LiveClient fed by hand: the two hooks must run on it alone, as they do on the second screen. */
function fakeClient(): { client: LiveClient; push: (topic: string, payload: unknown) => void } {
  const listeners = new Map<string, Set<(payload: never) => void>>()
  const client = {
    get: () => Promise.resolve(undefined),
    subscribe: (topic: string, listener: (payload: never) => void) => {
      const set = listeners.get(topic) ?? new Set()
      set.add(listener)
      listeners.set(topic, set)
      return () => set.delete(listener)
    },
    command: () => Promise.resolve()
  } as unknown as LiveClient
  return { client, push: (topic, payload) => listeners.get(topic)?.forEach((l) => l(payload as never)) }
}

const wrapper = (client: LiveClient) =>
  function Wrapper({ children }: { children: ReactNode }): React.JSX.Element {
    return <LiveClientContext.Provider value={client}>{children}</LiveClientContext.Provider>
  }

const MENU: GsxRemoteMenuState = {
  menuShown: true,
  searchActive: false,
  searchSession: 0,
  title: 'Select pushback direction',
  header: '',
  subtitle: '',
  entries: ['Left', 'Right'],
  icons: [],
  disabled: [],
  layout: 'list'
}

describe('useImportantGsxMenu on a LiveClient', () => {
  it('opens for an important menu on any page but GSX, and closes when GSX clears it', () => {
    const { client, push } = fakeClient()
    const { result, rerender } = renderHook(({ onGsx }) => useImportantGsxMenu(onGsx), {
      wrapper: wrapper(client),
      initialProps: { onGsx: false }
    })
    expect(result.current.open).toBe(false)
    act(() => push('gsxRemoteMenu', MENU))
    expect(result.current.open).toBe(true)
    rerender({ onGsx: true })
    expect(result.current.open).toBe(false) // answered in place on the GSX page
    rerender({ onGsx: false })
    act(() => push('gsxRemoteMenu', { ...MENU, menuShown: false, entries: [] }))
    expect(result.current.open).toBe(false)
  })

  it('reads the menu GSX is already showing when the screen mounts', async () => {
    const { client } = fakeClient()
    client.get = () => Promise.resolve(MENU) as never
    const { result } = renderHook(() => useImportantGsxMenu(false), { wrapper: wrapper(client) })
    await act(() => Promise.resolve())
    expect(result.current.open).toBe(true)
  })
})

describe('useAtcClearancePrompt on a LiveClient', () => {
  const selection: ProcedureSelection = { ...emptyProcedureSelection(), starIdent: 'SIER7B' }
  const state = (info: string): BeyondAtcState =>
    ({ infoBoxes: [{ title: 'STAR', info }], infoBoxesAt: 1_000 }) as BeyondAtcState

  it('offers a clearance that would change something, applies it on accept, and closes when the other screen already did', async () => {
    window.winglog = { appLogRendererError: vi.fn().mockResolvedValue(undefined) } as unknown as WingLogApi
    const { client, push } = fakeClient()
    const setSelection = vi.fn()
    const { result, rerender } = renderHook(({ sel }) => useAtcClearancePrompt(sel, setSelection), {
      wrapper: wrapper(client),
      initialProps: { sel: selection }
    })
    await act(async () => {
      push('beyondAtcState', state('LOGA2H'))
      await Promise.resolve()
    })
    expect(result.current.pending?.fields).toEqual({ starIdent: 'LOGA2H' })

    // The other screen pressed Update: the selection now holds what this prompt would apply.
    rerender({ sel: { ...selection, starIdent: 'LOGA2H' } })
    expect(result.current.pending).toBeNull()
  })

  describe('the pop-up gives way to the BeyondATC page after a minute (v2, Part 4)', () => {
    afterEach(() => vi.useRealTimers())

    async function offered(popupMs: number | null) {
      window.winglog = { appLogRendererError: vi.fn().mockResolvedValue(undefined) } as unknown as WingLogApi
      const { client, push } = fakeClient()
      const hook = renderHook(() => useAtcClearancePrompt(selection, vi.fn(), popupMs), {
        wrapper: wrapper(client)
      })
      const offer = async (star: string): Promise<void> => {
        await act(async () => {
          push('beyondAtcState', { ...state(star), infoBoxesAt: Math.random() * 1e6 })
          await Promise.resolve()
        })
      }
      await offer('LOGA2H')
      return { ...hook, offer }
    }

    it('opens the pop-up, then closes it after the minute while the same question stays pending', async () => {
      vi.useFakeTimers()
      const { result } = await offered(60_000)
      expect(result.current.popupOpen).toBe(true)
      act(() => vi.advanceTimersByTime(59_000))
      expect(result.current.popupOpen).toBe(true)
      act(() => vi.advanceTimersByTime(1_000))
      expect(result.current.popupOpen).toBe(false)
      expect(result.current.pending?.fields).toEqual({ starIdent: 'LOGA2H' })
    })

    it('opens a pop-up again for a newer clearance', async () => {
      vi.useFakeTimers()
      const { result, offer } = await offered(60_000)
      act(() => vi.advanceTimersByTime(60_000))
      expect(result.current.popupOpen).toBe(false)
      await offer('BNN1A')
      expect(result.current.pending?.fields).toEqual({ starIdent: 'BNN1A' })
      expect(result.current.popupOpen).toBe(true)
    })

    it('keeps the pop-up open for ever where there is no BeyondATC page (the second screen)', async () => {
      vi.useFakeTimers()
      const { result } = await offered(null)
      act(() => vi.advanceTimersByTime(10 * 60_000))
      expect(result.current.popupOpen).toBe(true)
    })

    it('has no pop-up, and no timer, once the question is answered', async () => {
      vi.useFakeTimers()
      const { result } = await offered(60_000)
      act(() => result.current.onDismiss())
      expect(result.current.pending).toBeNull()
      expect(result.current.popupOpen).toBe(false)
    })
  })

  describe('while the pilot is online', () => {
    const online = {
      network: 'vatsim',
      state: 'online',
      callsign: 'BAW1',
      filedPlan: null,
      hidesBeyondAtc: true
    }
    const offline = { ...online, state: 'offline', callsign: null, hidesBeyondAtc: false }

    it('offers no clearance, and offers one again once the pilot is offline', async () => {
      window.winglog = { appLogRendererError: vi.fn().mockResolvedValue(undefined) } as unknown as WingLogApi
      const { client, push } = fakeClient()
      const { result } = renderHook(() => useAtcClearancePrompt(selection, vi.fn()), {
        wrapper: wrapper(client)
      })
      act(() => push('onlineStatus', online))
      await act(async () => {
        push('beyondAtcState', state('LOGA2H'))
        await Promise.resolve()
      })
      expect(result.current.pending).toBeNull()

      act(() => push('onlineStatus', offline))
      await act(async () => {
        push('beyondAtcState', state('LOGA2H'))
        await Promise.resolve()
      })
      expect(result.current.pending?.fields).toEqual({ starIdent: 'LOGA2H' })
    })

    it('withdraws a clearance that was already on offer', async () => {
      window.winglog = { appLogRendererError: vi.fn().mockResolvedValue(undefined) } as unknown as WingLogApi
      const { client, push } = fakeClient()
      const { result } = renderHook(() => useAtcClearancePrompt(selection, vi.fn()), {
        wrapper: wrapper(client)
      })
      await act(async () => {
        push('beyondAtcState', state('LOGA2H'))
        await Promise.resolve()
      })
      expect(result.current.pending).not.toBeNull()
      act(() => push('onlineStatus', online))
      expect(result.current.pending).toBeNull()
    })
  })

  it('applies an accepted clearance over the current selection', async () => {
    window.winglog = { appLogRendererError: vi.fn().mockResolvedValue(undefined) } as unknown as WingLogApi
    const { client, push } = fakeClient()
    const setSelection = vi.fn()
    const { result } = renderHook(() => useAtcClearancePrompt(selection, setSelection), {
      wrapper: wrapper(client)
    })
    await act(async () => {
      push('beyondAtcState', state('LOGA2H'))
      await Promise.resolve()
    })
    act(() => result.current.onAccept())
    const apply = setSelection.mock.calls[0][0] as (prev: ProcedureSelection) => ProcedureSelection
    expect(apply(selection)).toEqual({ ...selection, starIdent: 'LOGA2H' })
    expect(result.current.pending).toBeNull()
  })

  it('drops the old procedure transition when the accepted clearance names a different procedure', async () => {
    window.winglog = { appLogRendererError: vi.fn().mockResolvedValue(undefined) } as unknown as WingLogApi
    const { client, push } = fakeClient()
    const setSelection = vi.fn()
    const flown = { ...selection, starIdent: 'UPRS2C', starTransition: 'SY498' }
    const { result } = renderHook(() => useAtcClearancePrompt(flown, setSelection), {
      wrapper: wrapper(client)
    })
    await act(async () => {
      push('beyondAtcState', state('LOGA2H'))
      await Promise.resolve()
    })
    act(() => result.current.onAccept())
    const apply = setSelection.mock.calls[0][0] as (prev: ProcedureSelection) => ProcedureSelection
    expect(apply(flown)).toMatchObject({ starIdent: 'LOGA2H', starTransition: null })
  })
})

describe('useAtcClearancePrompt writes what it did to main.log', () => {
  const selection: ProcedureSelection = { ...emptyProcedureSelection(), starIdent: 'SIER7B' }
  const boxes = (title: string, info: string): BeyondAtcState =>
    ({ infoBoxes: [{ title, info }], infoBoxesAt: 1_000 }) as BeyondAtcState
  const online = {
    network: 'vatsim',
    state: 'online',
    callsign: 'BAW1',
    filedPlan: null,
    hidesBeyondAtc: true
  }

  afterEach(() => vi.useRealTimers())

  function setup(popupMs: number | null = null, sel: ProcedureSelection = selection) {
    const lines: string[] = []
    window.winglog = {
      appLogRendererError: vi.fn().mockResolvedValue(undefined),
      appLogRendererInfo: vi.fn((tag: string, message: string) => {
        lines.push(`[${tag}] ${message}`)
        return Promise.resolve()
      })
    } as unknown as WingLogApi
    const { client, push } = fakeClient()
    const hook = renderHook(({ s }) => useAtcClearancePrompt(s, vi.fn(), popupMs), {
      wrapper: wrapper(client),
      initialProps: { s: sel }
    })
    const hear = async (state: BeyondAtcState): Promise<void> => {
      await act(async () => {
        push('beyondAtcState', state)
        await Promise.resolve()
      })
    }
    return { ...hook, lines, hear, push }
  }

  it('says what was read, what the selection was, and that the clearance was offered, then accepted', async () => {
    const { result, lines, hear } = setup()
    await hear(boxes('STAR', 'LOGA2H'))
    expect(lines).toEqual([
      '[atc-prompt] read "STAR LOGA2H" (starIdent=LOGA2H) from boxes at 1970-01-01T00:00:01.000Z; selection: starIdent=SIER7B',
      '[atc-prompt] offered "STAR LOGA2H" (starIdent=LOGA2H) from boxes at 1970-01-01T00:00:01.000Z'
    ])
    act(() => result.current.onAccept())
    expect(lines.at(-1)).toBe('[atc-prompt] accepted "STAR LOGA2H"')
  })

  it('says a clearance was dismissed', async () => {
    const { result, lines, hear } = setup()
    await hear(boxes('STAR', 'LOGA2H'))
    act(() => result.current.onDismiss())
    expect(lines.at(-1)).toBe('[atc-prompt] dismissed "STAR LOGA2H"')
  })

  it('says why a clearance that matches the selection got no prompt', async () => {
    const { lines, hear } = setup()
    await hear(boxes('STAR', 'SIER7B'))
    expect(lines.at(-1)).toBe(
      '[atc-prompt] no prompt for "STAR SIER7B": it matches the selection (starIdent=SIER7B)'
    )
  })

  it('says nothing for a set of boxes that carries no clearance', async () => {
    const { lines, hear } = setup()
    await hear(boxes('QNH', '1014'))
    expect(lines).toEqual([])
  })

  it('says once that a repeated set was already read, however often BeyondATC repeats it', async () => {
    const { lines, hear } = setup()
    await hear(boxes('STAR', 'LOGA2H'))
    await hear(boxes('STAR', 'LOGA2H'))
    await hear(boxes('STAR', 'LOGA2H'))
    expect(lines.filter((line) => line.includes('already read'))).toEqual([
      '[atc-prompt] no prompt for "STAR LOGA2H": this set of boxes was already read'
    ])
  })

  it('says once that a clearance was not offered because the pilot is online, and that an offered one was withdrawn', async () => {
    const { lines, hear, push, result } = setup()
    act(() => push('onlineStatus', online))
    await hear(boxes('STAR', 'LOGA2H'))
    await hear(boxes('STAR', 'LOGA2H'))
    expect(lines).toEqual(['[atc-prompt] no prompt for "STAR LOGA2H": online, BeyondATC is hidden'])
    expect(result.current.pending).toBeNull()
  })

  it('says an offered clearance was withdrawn when it goes online, or the other screen already applied it', async () => {
    const first = setup()
    await first.hear(boxes('STAR', 'LOGA2H'))
    act(() => first.push('onlineStatus', online))
    expect(first.lines.at(-1)).toBe('[atc-prompt] "STAR LOGA2H" withdrawn: online')

    const second = setup()
    await second.hear(boxes('STAR', 'LOGA2H'))
    second.rerender({ s: { ...selection, starIdent: 'LOGA2H' } })
    expect(second.lines.at(-1)).toBe(
      '[atc-prompt] "STAR LOGA2H" withdrawn: the selection already holds it (answered on another screen)'
    )
  })

  it('says a newer clearance replaced one still waiting', async () => {
    const { lines, hear } = setup()
    await hear(boxes('STAR', 'LOGA2H'))
    await hear(boxes('STAR', 'BNN1A'))
    expect(lines.filter((line) => line.includes('replaced'))).toEqual([
      '[atc-prompt] "STAR LOGA2H" replaced by a newer clearance'
    ])
  })

  it('says when the pop-up timed out and the question moved to the BeyondATC page', async () => {
    vi.useFakeTimers()
    const { lines, hear } = setup(60_000)
    await hear(boxes('STAR', 'LOGA2H'))
    act(() => vi.advanceTimersByTime(60_000))
    expect(lines.at(-1)).toBe('[atc-prompt] no answer in 60 s: "STAR LOGA2H" moved to the BeyondATC page')
  })

  it('works where nothing can log (the phone page, or a test with no log call)', async () => {
    window.winglog = { appLogRendererError: vi.fn().mockResolvedValue(undefined) } as unknown as WingLogApi
    const { client, push } = fakeClient()
    const { result } = renderHook(() => useAtcClearancePrompt(selection, vi.fn()), {
      wrapper: wrapper(client)
    })
    await act(async () => {
      push('beyondAtcState', boxes('STAR', 'LOGA2H'))
      await Promise.resolve()
    })
    expect(result.current.pending?.fields).toEqual({ starIdent: 'LOGA2H' })
  })
})
