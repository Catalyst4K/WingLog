import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OnlineStatus } from '@shared/ipc'
import { LiveClientContext, type LiveClient } from '../live/LiveClient'
import { OnlineBadge } from './OnlineBadge'

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
      <OnlineBadge />
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

describe('OnlineBadge', () => {
  it('names the network and the callsign, with the full sentence as its title', async () => {
    renderWith(base)
    const badge = await screen.findByText('VATSIM · BAW1')
    expect(badge).toHaveAttribute('title', 'Online on VATSIM as BAW1.')
  })

  it('names IVAO for IVAO', async () => {
    renderWith({ ...base, network: 'ivao', callsign: 'IVA123' })
    expect(await screen.findByText('IVAO · IVA123')).toBeInTheDocument()
  })

  it('ends a "probably" match in a question mark and says why in its title', async () => {
    renderWith({ ...base, state: 'probably' })
    const badge = await screen.findByText('VATSIM · BAW1?')
    expect(badge.getAttribute('title')).toMatch(
      /^Probably online on VATSIM as BAW1: .*Enter your CID in Settings/
    )
  })

  it('shows whether or not BeyondATC is hidden, since it says the pilot is online, not what is hidden', async () => {
    renderWith({ ...base, hidesBeyondAtc: false })
    expect(await screen.findByText('VATSIM · BAW1')).toBeInTheDocument()
  })

  it('shows nothing until the pilot is found, and goes when they go offline', async () => {
    const push = renderWith(undefined)
    act(() => push({ ...base, state: 'unknown', callsign: null, hidesBeyondAtc: false }))
    expect(screen.queryByText(/VATSIM/)).not.toBeInTheDocument()
    act(() => push(base))
    expect(screen.getByText('VATSIM · BAW1')).toBeInTheDocument()
    act(() => push({ ...base, state: 'offline', callsign: null, hidesBeyondAtc: false }))
    expect(screen.queryByText(/VATSIM/)).not.toBeInTheDocument()
  })
})
