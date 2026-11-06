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
