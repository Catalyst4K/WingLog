import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BeyondAtcConnectionStatus, BeyondAtcState, OnlineStatus } from '@shared/ipc'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { LiveClientContext, type LiveClient } from '../live/LiveClient'
import { AutoTuneOnlineWarning } from './AutoTuneOnlineWarning'

interface Topics {
  onlineStatus?: OnlineStatus
  beyondAtcStatus?: BeyondAtcConnectionStatus
  beyondAtcState?: BeyondAtcState
}

/** Renders the warning against a live client holding `initial`, and returns a way to push a topic's next value. */
function renderWith(
  initial: Topics
): <T extends keyof Topics>(topic: T, value: NonNullable<Topics[T]>) => void {
  const listeners = new Map<string, (value: unknown) => void>()
  const client = {
    get: (topic: keyof Topics) => Promise.resolve(initial[topic]),
    subscribe: (topic: string, listener: (value: unknown) => void) => {
      listeners.set(topic, listener)
      return () => undefined
    },
    command: vi.fn()
  } as unknown as LiveClient
  render(
    <LiveClientContext.Provider value={client}>
      <AutoTuneOnlineWarning />
    </LiveClientContext.Provider>
  )
  return (topic, value) => listeners.get(topic)?.(value)
}

const ONLINE: OnlineStatus = {
  network: 'vatsim',
  state: 'online',
  callsign: 'TSTPIL1',
  filedPlan: null,
  hidesBeyondAtc: true
}
const CONNECTED: BeyondAtcConnectionStatus = { state: 'connected', lastError: null }
const AUTO_TUNE_ON: BeyondAtcState = { ...EMPTY_BEYONDATC_STATE, autoTune: true }

describe('AutoTuneOnlineWarning', () => {
  it('warns while online with a connected BeyondATC whose auto-tune is on, naming the network', async () => {
    renderWith({ onlineStatus: ONLINE, beyondAtcStatus: CONNECTED, beyondAtcState: AUTO_TUNE_ON })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "BeyondATC's auto-tune is on and can retune your radios away from VATSIM's controllers."
    )
  })

  it('names IVAO for IVAO, and still warns when BeyondATC is kept while online', async () => {
    renderWith({
      onlineStatus: { ...ONLINE, network: 'ivao', hidesBeyondAtc: false },
      beyondAtcStatus: CONNECTED,
      beyondAtcState: AUTO_TUNE_ON
    })
    expect(await screen.findByText(/away from IVAO's controllers/)).toBeInTheDocument()
  })

  it('goes when auto-tune is switched off, when BeyondATC closes, and when the pilot goes offline', async () => {
    const push = renderWith({
      onlineStatus: ONLINE,
      beyondAtcStatus: CONNECTED,
      beyondAtcState: AUTO_TUNE_ON
    })
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    act(() => push('beyondAtcState', { ...AUTO_TUNE_ON, autoTune: false }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    act(() => push('beyondAtcState', AUTO_TUNE_ON))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    // BeyondATC closes: its last auto-tune value is still "on", but it can no longer retune anything.
    act(() => push('beyondAtcStatus', { state: 'disconnected', lastError: null }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    act(() => push('beyondAtcStatus', CONNECTED))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    act(() => push('onlineStatus', { ...ONLINE, state: 'offline', callsign: null, hidesBeyondAtc: false }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says nothing before the topics arrive', () => {
    renderWith({})
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
