import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BeyondAtcConnectionStatus, BeyondAtcSettings, BeyondAtcState, BeyondAtcTranscriptEntry, WingLogApi } from '@shared/ipc'
import { BeyondAtcPanel } from './BeyondAtcPanel'

function makeSettings(overrides: Partial<BeyondAtcSettings> = {}): BeyondAtcSettings {
  return { enabled: true, host: 'localhost', ...overrides }
}

function makeStatus(overrides: Partial<BeyondAtcConnectionStatus> = {}): BeyondAtcConnectionStatus {
  return { state: 'connected', lastError: null, ...overrides }
}

function makeState(overrides: Partial<BeyondAtcState> = {}): BeyondAtcState {
  return { facility: null, com2: null, callsign: null, commsState: null, progress: null, actions: [], ...overrides }
}

function withWinglog(overrides: Partial<WingLogApi> = {}): void {
  window.winglog = {
    settingsGetBeyondAtc: vi.fn().mockResolvedValue(makeSettings()),
    beyondAtcGetStatus: vi.fn().mockResolvedValue(makeStatus()),
    onBeyondAtcStatus: vi.fn().mockReturnValue(() => {}),
    beyondAtcGetState: vi.fn().mockResolvedValue(makeState()),
    onBeyondAtcState: vi.fn().mockReturnValue(() => {}),
    beyondAtcGetTranscript: vi.fn().mockResolvedValue([]),
    onBeyondAtcTranscript: vi.fn().mockReturnValue(() => {}),
    beyondAtcSetAction: vi.fn().mockResolvedValue(undefined),
    beyondAtcSetFrequency: vi.fn().mockResolvedValue(undefined),
    beyondAtcSetFrequencyCom2: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as WingLogApi
}

describe('BeyondAtcPanel', () => {
  it('shows a not-configured message when BeyondATC integration is off', async () => {
    withWinglog({ settingsGetBeyondAtc: vi.fn().mockResolvedValue(makeSettings({ enabled: false })) })
    render(<BeyondAtcPanel />)

    expect(await screen.findByText(/BeyondATC integration is off/)).toBeInTheDocument()
  })

  it('shows a connecting message while not yet connected', async () => {
    withWinglog({ beyondAtcGetStatus: vi.fn().mockResolvedValue(makeStatus({ state: 'connecting' })) })
    render(<BeyondAtcPanel />)

    expect(await screen.findByText('Connecting to BeyondATC…')).toBeInTheDocument()
  })

  it('shows a disconnected message once connected has been lost', async () => {
    withWinglog({ beyondAtcGetStatus: vi.fn().mockResolvedValue(makeStatus({ state: 'disconnected' })) })
    render(<BeyondAtcPanel />)

    expect(await screen.findByText('Not connected to BeyondATC.')).toBeInTheDocument()
  })

  it('renders the tuned facility, callsign and progress once connected', async () => {
    withWinglog({
      beyondAtcGetState: vi.fn().mockResolvedValue(
        makeState({
          facility: { name: 'Brisbane Delivery', frequency: '118.850' },
          callsign: { full: 'Cathay 116 Heavy', shortForm: 'CPA116' },
          progress: { from: 'YBBN', to: 'YSSY', pct: 12 }
        })
      )
    })
    render(<BeyondAtcPanel />)

    expect(await screen.findByText('Cathay 116 Heavy')).toBeInTheDocument()
    expect(screen.getByText('Tuned to Brisbane Delivery (118.850)')).toBeInTheDocument()
    expect(screen.getByText('YBBN → YSSY · 12%')).toBeInTheDocument()
  })

  it('shows the live comms mode indicator', async () => {
    withWinglog({
      beyondAtcGetState: vi.fn().mockResolvedValue(makeState({ commsState: { mode: 'awaiting', text: 'Awaiting Response' } }))
    })
    render(<BeyondAtcPanel />)

    expect(await screen.findByText('Awaiting response — Awaiting Response')).toBeInTheDocument()
  })

  it('renders the transcript, tagged by speaker', async () => {
    const transcript: BeyondAtcTranscriptEntry[] = [
      { speaker: 'player', text: 'Cathay 116 Heavy, radio check.', ts: 1 },
      { speaker: 'atc', text: 'Cathay 116 Heavy, readability 5.', ts: 2 }
    ]
    withWinglog({ beyondAtcGetTranscript: vi.fn().mockResolvedValue(transcript) })
    render(<BeyondAtcPanel />)

    expect(await screen.findByText('Cathay 116 Heavy, radio check.')).toBeInTheDocument()
    expect(screen.getByText('Cathay 116 Heavy, readability 5.')).toBeInTheDocument()
    expect(screen.getByText('You:')).toBeInTheDocument()
    expect(screen.getByText('ATC:')).toBeInTheDocument()
  })

  it('clicking an action button calls beyondAtcSetAction with the exact label', async () => {
    const beyondAtcSetAction = vi.fn().mockResolvedValue(undefined)
    withWinglog({
      beyondAtcGetState: vi.fn().mockResolvedValue(makeState({ actions: ['Radio Check'] })),
      beyondAtcSetAction
    })
    const user = userEvent.setup()
    render(<BeyondAtcPanel />)

    await user.click(await screen.findByRole('button', { name: 'Radio Check' }))

    expect(beyondAtcSetAction).toHaveBeenCalledWith('Radio Check')
  })

  it('subscribes to live status/state/transcript updates and unsubscribes on unmount', async () => {
    const unsubscribeStatus = vi.fn()
    const unsubscribeState = vi.fn()
    const unsubscribeTranscript = vi.fn()
    withWinglog({
      onBeyondAtcStatus: vi.fn().mockReturnValue(unsubscribeStatus),
      onBeyondAtcState: vi.fn().mockReturnValue(unsubscribeState),
      onBeyondAtcTranscript: vi.fn().mockReturnValue(unsubscribeTranscript)
    })
    const { unmount } = render(<BeyondAtcPanel />)
    // The on* subscriptions are registered synchronously inside the mount effect, before any
    // of the get* promises resolve — no need to wait for settings/state to load first.
    unmount()

    expect(unsubscribeStatus).toHaveBeenCalled()
    expect(unsubscribeState).toHaveBeenCalled()
    expect(unsubscribeTranscript).toHaveBeenCalled()
  })
})
