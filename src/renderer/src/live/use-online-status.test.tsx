import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { OnlineStatus } from '@shared/ipc'
import { LiveClientContext, type LiveClient } from './LiveClient'
import { useBeyondAtcHidden, useOnlineStatus } from './use-online-status'

const ONLINE: OnlineStatus = {
  network: 'vatsim',
  state: 'online',
  callsign: 'BAW1',
  filedPlan: null,
  hidesBeyondAtc: true
}

function setup(held?: OnlineStatus) {
  let push: (status: OnlineStatus) => void = () => undefined
  const unsubscribe = vi.fn()
  const client = {
    get: vi.fn(() => Promise.resolve(held)),
    subscribe: vi.fn((_topic: string, listener: (status: OnlineStatus) => void) => {
      push = listener
      return unsubscribe
    }),
    command: vi.fn()
  } as unknown as LiveClient
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <LiveClientContext.Provider value={client}>{children}</LiveClientContext.Provider>
  )
  return { client, wrapper, unsubscribe, push: (status: OnlineStatus) => push(status) }
}

describe('useOnlineStatus', () => {
  it('starts as not online, then takes the held status and each push', async () => {
    const { wrapper, push } = setup(ONLINE)
    const { result } = renderHook(() => useOnlineStatus(), { wrapper })
    expect(result.current).toMatchObject({ state: 'unknown', hidesBeyondAtc: false })
    await act(async () => {})
    expect(result.current).toEqual(ONLINE)
    act(() => push({ ...ONLINE, state: 'offline', hidesBeyondAtc: false }))
    expect(result.current.state).toBe('offline')
  })

  it('stops following when it unmounts', async () => {
    const { wrapper, unsubscribe } = setup()
    const { unmount } = renderHook(() => useOnlineStatus(), { wrapper })
    await act(async () => {})
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('stays not online, and does not throw, when the live client cannot be reached', async () => {
    const client = {
      get: () => {
        throw new Error('no preload')
      },
      subscribe: vi.fn(),
      command: vi.fn()
    } as unknown as LiveClient
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <LiveClientContext.Provider value={client}>{children}</LiveClientContext.Provider>
    )
    const { result } = renderHook(() => useBeyondAtcHidden(), { wrapper })
    await act(async () => {})
    expect(result.current).toBe(false)
  })

  it('stays not online when the first read is rejected', async () => {
    const { wrapper, client } = setup()
    ;(client.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gone'))
    const { result } = renderHook(() => useBeyondAtcHidden(), { wrapper })
    await act(async () => {})
    expect(result.current).toBe(false)
  })
})

describe('useBeyondAtcHidden', () => {
  it('is true only while main says BeyondATC is hidden', async () => {
    const { wrapper, push } = setup()
    const { result } = renderHook(() => useBeyondAtcHidden(), { wrapper })
    expect(result.current).toBe(false)
    act(() => push(ONLINE))
    expect(result.current).toBe(true)
    act(() => push({ ...ONLINE, hidesBeyondAtc: false }))
    expect(result.current).toBe(false)
  })
})
