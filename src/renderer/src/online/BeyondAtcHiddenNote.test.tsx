import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OnlineStatus } from '@shared/ipc'
import { LiveClientContext, type LiveClient } from '../live/LiveClient'
import { BeyondAtcHiddenNote } from './BeyondAtcHiddenNote'

function renderWith(initial: OnlineStatus | undefined): (status: OnlineStatus) => void {
  let push: (status: OnlineStatus) => void = () => undefined
  const client = {
    get: () => Promise.resolve(initial),
    subscribe: (_topic: string, listener: (status: OnlineStatus) => void) => {
      push = listener
      return () => undefined
    },
    command: vi.fn()
  } as unknown as LiveClient
  render(
    <LiveClientContext.Provider value={client}>
      <BeyondAtcHiddenNote />
    </LiveClientContext.Provider>
  )
  return (status) => push(status)
}

const base: OnlineStatus = {
  network: 'vatsim',
  state: 'online',
  callsign: 'BAW1',
  filedPlan: null,
  hidesBeyondAtc: true
}

describe('BeyondAtcHiddenNote', () => {
  it('says why BeyondATC is hidden, naming the network', async () => {
    renderWith(base)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'BeyondATC is hidden while you are online on VATSIM.'
    )
  })

  it('names IVAO for IVAO', async () => {
    renderWith({ ...base, network: 'ivao' })
    expect(await screen.findByText(/online on IVAO/)).toBeInTheDocument()
  })

  it('says nothing while BeyondATC is shown, and goes when the pilot goes offline', async () => {
    const push = renderWith(undefined)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    act(() => push(base))
    expect(screen.getByRole('status')).toBeInTheDocument()
    act(() => push({ ...base, state: 'offline', hidesBeyondAtc: false }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
