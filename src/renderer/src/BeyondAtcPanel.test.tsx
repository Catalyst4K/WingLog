import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BeyondAtcConnectionStatus, BeyondAtcSettings, BeyondAtcState, BeyondAtcTranscriptEntry, WingLogApi } from '@shared/ipc'
import { BeyondAtcPanel, PENDING_ACTION_TIMEOUT_MS } from './BeyondAtcPanel'

function makeSettings(overrides: Partial<BeyondAtcSettings> = {}): BeyondAtcSettings {
  return { enabled: true, host: 'localhost', ...overrides }
}

function makeStatus(overrides: Partial<BeyondAtcConnectionStatus> = {}): BeyondAtcConnectionStatus {
  return { state: 'connected', lastError: null, ...overrides }
}

function makeState(overrides: Partial<BeyondAtcState> = {}): BeyondAtcState {
  return {
    facility: null,
    com2: null,
    callsign: null,
    commsState: null,
    progress: null,
    actions: [],
    autoTune: null,
    autoRespond: null,
    frequencies: [],
    ...overrides
  }
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
    beyondAtcSetAutoTune: vi.fn().mockResolvedValue(undefined),
    beyondAtcSetAutoRespond: vi.fn().mockResolvedValue(undefined),
    beyondAtcGetStepClimb: vi.fn().mockResolvedValue({ enabled: false, nextStep: null, pendingAltitudeFt: null, waitingForClimbFt: null, pastTopOfDescent: false, last: null }),
    onBeyondAtcStepClimb: vi.fn(() => () => {}),
    beyondAtcSetStepClimb: vi.fn().mockResolvedValue(undefined),
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

  it('shows a persistent connected message even with nothing else to display (real gap found live, 2026-09-28)', async () => {
    withWinglog()
    render(<BeyondAtcPanel />)

    expect(await screen.findByText('Connected to BeyondATC.')).toBeInTheDocument()
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
    expect(screen.getByText('Brisbane Delivery (118.850)')).toBeInTheDocument()
    expect(screen.getByText('YBBN → YSSY · 12%')).toBeInTheDocument()
  })

  it('renders the transcript, tagged by speaker', async () => {
    const transcript: BeyondAtcTranscriptEntry[] = [
      { speaker: 'player', text: 'Cathay 116 Heavy, radio check.', ts: 1 },
      { speaker: 'atc', text: 'Cathay 116 Heavy, readability 5.', ts: 2 }
    ]
    withWinglog({ beyondAtcGetTranscript: vi.fn().mockResolvedValue(transcript) })
    render(<BeyondAtcPanel />)

    expect(await screen.findByText('Cathay 116 Heavy, radio check.')).toBeInTheDocument()
    // Twice: in the transcript, and as the Latest instruction card's full text.
    expect(screen.getAllByText('Cathay 116 Heavy, readability 5.')).toHaveLength(2)
    expect(screen.getByText('You:')).toBeInTheDocument()
    expect(screen.getByText('ATC:')).toBeInTheDocument()
  })

  it('scrolls the newest transcript line into view when a new entry arrives', async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    const first: BeyondAtcTranscriptEntry[] = [{ speaker: 'player', text: 'Cathay 116 Heavy, radio check.', ts: 1 }]
    let pushTranscript: (entries: BeyondAtcTranscriptEntry[]) => void = () => {}
    withWinglog({
      beyondAtcGetTranscript: vi.fn().mockResolvedValue(first),
      onBeyondAtcTranscript: vi.fn().mockImplementation((cb) => {
        pushTranscript = cb
        return () => {}
      })
    })
    render(<BeyondAtcPanel />)
    await screen.findByText('Cathay 116 Heavy, radio check.')
    scrollIntoView.mockClear()

    pushTranscript([...first, { speaker: 'atc', text: 'Cathay 116 Heavy, readability 5.', ts: 2 }])
    await screen.findAllByText('Cathay 116 Heavy, readability 5.')

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    scrollIntoView.mockRestore()
  })

  it("shows the latest ATC instruction's key facts in their own card, separate from the callsign/progress strip", async () => {
    const transcript: BeyondAtcTranscriptEntry[] = [
      { speaker: 'atc', text: 'Hongkong Shuttle 250, contact Hong Kong Tower 118.2.', ts: 1 },
      {
        speaker: 'atc',
        text: 'Hongkong Shuttle 250, Hong Kong Tower, wind 200 degrees, 7 knots, runway 25C, cleared for takeoff.',
        ts: 2
      }
    ]
    withWinglog({ beyondAtcGetTranscript: vi.fn().mockResolvedValue(transcript) })
    render(<BeyondAtcPanel />)

    const card = (await screen.findByText('Latest instruction')).closest('[data-slot="card"]') as HTMLElement
    expect(within(card).getByText('Cleared for takeoff')).toBeInTheDocument()
    expect(within(card).getByText('Hong Kong Tower')).toBeInTheDocument()
    expect(within(card).getByText('25C')).toBeInTheDocument()
    expect(within(card).getByText('200° 7 kt')).toBeInTheDocument()
    // Only the most recent instruction — the earlier handoff isn't carried over.
    expect(within(card).queryByText('Hong Kong Tower 118.2')).not.toBeInTheDocument()
  })

  it('shows a real VHHH flight-level clearance (2026-09-30) with its ATIS letter', async () => {
    const transcript: BeyondAtcTranscriptEntry[] = [
      {
        speaker: 'atc',
        text: 'Hongkong Shuttle 250, Hong Kong Delivery, information H current, cleared to Phoenix airport via PECA1D departure, runway 25C, climb via SID to FL140, squawk 6140.',
        ts: 1
      }
    ]
    withWinglog({ beyondAtcGetTranscript: vi.fn().mockResolvedValue(transcript) })
    render(<BeyondAtcPanel />)

    const card = (await screen.findByText('Latest instruction')).closest('[data-slot="card"]') as HTMLElement
    await within(card).findByText('PECA1D')
    for (const value of ['Hong Kong Delivery', 'H', 'Phoenix airport', '25C', 'FL140', '6140']) {
      expect(within(card).getByText(value)).toBeInTheDocument()
    }
  })

  it('keeps a real YBBN clearance (2026-10-02) on the card through "readback correct", adding the next frequency', async () => {
    const transcript: BeyondAtcTranscriptEntry[] = [
      {
        speaker: 'atc',
        text: 'Cathay 168 Heavy, Brisbane Delivery, information A current, cleared to Hong Kong airport via the BIXAD2 departure, runway 01R, climb via SID to 10000 feet, squawk 6022.',
        ts: 1
      },
      { speaker: 'atc', text: 'Cathay 168 Heavy, readback correct. Contact ground 122.25 when ready for pushback or engine start.', ts: 2 }
    ]
    withWinglog({ beyondAtcGetTranscript: vi.fn().mockResolvedValue(transcript) })
    render(<BeyondAtcPanel />)

    const card = (await screen.findByText('Latest instruction')).closest('[data-slot="card"]') as HTMLElement
    await within(card).findByText('BIXAD2')
    for (const value of ['Brisbane Delivery', 'Hong Kong airport', '01R', '10,000 ft', '6022', 'ground 122.25']) {
      expect(within(card).getByText(value)).toBeInTheDocument()
    }
  })

  it('shows placeholders when no status is known and ATC has said nothing yet', async () => {
    withWinglog({
      beyondAtcGetTranscript: vi.fn().mockResolvedValue([{ speaker: 'player', text: 'Cathay 116 Heavy, radio check.', ts: 1 }])
    })
    render(<BeyondAtcPanel />)

    await screen.findByText('Cathay 116 Heavy, radio check.')
    expect(screen.getByText('No status yet.')).toBeInTheDocument()
    expect(screen.getByText('No instructions from ATC yet.')).toBeInTheDocument()
  })

  it('always shows every card — Actions, Radios and Transcript — even with nothing tuned/said yet, each with its own placeholder', async () => {
    render(<BeyondAtcPanel />)

    expect(await screen.findByText('Actions')).toBeInTheDocument()
    expect(screen.getByText('No actions available right now.')).toBeInTheDocument()
    expect(screen.getByText('Radios')).toBeInTheDocument()
    expect(screen.getByText('Transcript')).toBeInTheDocument()
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

  describe('feedback after pressing an action (Callum, 2026-10-02: a press queued behind traffic looked like it did nothing)', () => {
    // Real action labels, YBBN 2026-10-02.
    const ACTIONS = ['Request Taxi', 'Radio Check']

    function withStateListener(): { push: (state: BeyondAtcState) => void } {
      let listener: (state: BeyondAtcState) => void = () => {}
      withWinglog({
        beyondAtcGetState: vi.fn().mockResolvedValue(makeState({ actions: ACTIONS })),
        onBeyondAtcState: vi.fn((l: (state: BeyondAtcState) => void) => {
          listener = l
          return () => {}
        }) as unknown as WingLogApi['onBeyondAtcState']
      })
      return { push: (state) => act(() => listener(state)) }
    }

    it('marks the pressed button busy straight away and says it is queued while traffic talks', async () => {
      const { push } = withStateListener()
      render(<BeyondAtcPanel />)
      fireEvent.click(await screen.findByRole('button', { name: 'Request Taxi' }))

      expect(screen.getByRole('button', { name: 'Request Taxi' })).toHaveAttribute('aria-busy', 'true')
      expect(screen.getByRole('button', { name: 'Radio Check' })).not.toHaveAttribute('aria-busy')
      expect(screen.getByRole('status')).toHaveTextContent('Queued: Request Taxi. Waiting for a gap on the frequency.')

      push(makeState({ actions: ACTIONS, commsState: { mode: 'traffic', text: '' } }))
      expect(screen.getByRole('status')).toHaveTextContent('Queued: Request Taxi.')
    })

    it('clears the busy state once the call is transmitted, then shows the wait for ATC', async () => {
      const { push } = withStateListener()
      render(<BeyondAtcPanel />)
      fireEvent.click(await screen.findByRole('button', { name: 'Request Taxi' }))

      push(makeState({ actions: ACTIONS, commsState: { mode: 'speaking', text: '' } }))
      expect(screen.getByRole('button', { name: 'Request Taxi' })).not.toHaveAttribute('aria-busy')
      expect(screen.getByRole('status')).toHaveTextContent('Transmitting…')

      push(makeState({ actions: ACTIONS, commsState: { mode: 'awaiting', text: '' } }))
      expect(screen.getByRole('status')).toHaveTextContent("Awaiting ATC's reply.")

      push(makeState({ actions: ACTIONS, commsState: { mode: 'ready', text: '' } }))
      expect(screen.getByRole('status')).toBeEmptyDOMElement()
    })

    it('moves the busy state to a second press, and gives up after a minute with no news', async () => {
      withStateListener()
      render(<BeyondAtcPanel />)
      const taxi = await screen.findByRole('button', { name: 'Request Taxi' })
      vi.useFakeTimers()
      try {
        fireEvent.click(taxi)
        fireEvent.click(screen.getByRole('button', { name: 'Radio Check' }))
        expect(screen.getByRole('button', { name: 'Request Taxi' })).not.toHaveAttribute('aria-busy')
        expect(screen.getByRole('button', { name: 'Radio Check' })).toHaveAttribute('aria-busy', 'true')

        act(() => vi.advanceTimersByTime(PENDING_ACTION_TIMEOUT_MS))
        expect(screen.getByRole('button', { name: 'Radio Check' })).not.toHaveAttribute('aria-busy')
        expect(screen.getByRole('status')).toBeEmptyDOMElement()
      } finally {
        vi.useRealTimers()
      }
    })

    it('says the frequency is busy for a call queued from BeyondATC itself', async () => {
      const { push } = withStateListener()
      render(<BeyondAtcPanel />)
      await screen.findByRole('button', { name: 'Request Taxi' })
      push(makeState({ actions: ACTIONS, commsState: { mode: 'queued', text: '' } }))
      expect(screen.getByRole('status')).toHaveTextContent('Waiting for a gap on the frequency.')
    })
  })

  it('clicking an AutoTune toggle calls beyondAtcSetAutoTune with the flipped value', async () => {
    const beyondAtcSetAutoTune = vi.fn().mockResolvedValue(undefined)
    withWinglog({
      beyondAtcGetState: vi.fn().mockResolvedValue(makeState({ autoTune: true, autoRespond: false })),
      beyondAtcSetAutoTune
    })
    const user = userEvent.setup()
    render(<BeyondAtcPanel />)

    await user.click(await screen.findByRole('button', { name: 'Auto-tune: On' }))

    expect(beyondAtcSetAutoTune).toHaveBeenCalledWith(false)
  })

  it('picking a frequency from the real list calls beyondAtcSetFrequency, runway shown alongside it', async () => {
    const beyondAtcSetFrequency = vi.fn().mockResolvedValue(undefined)
    withWinglog({
      beyondAtcGetState: vi.fn().mockResolvedValue(
        makeState({
          facility: { name: 'Changi UNICOM', frequency: '122.800' },
          progress: { from: 'WSSS', to: 'ZSPD', pct: 0 },
          frequencies: [
            {
              airport: 'WSSS',
              airportName: 'Changi',
              frequency: '124.050',
              name: 'SINGAPORE APPROACH',
              type: 'Approach',
              stationType: '',
              runways: '02L'
            }
          ]
        })
      ),
      beyondAtcSetFrequency
    })
    const user = userEvent.setup()
    render(<BeyondAtcPanel />)

    await user.click((await screen.findAllByRole('button', { name: 'Frequencies' }))[0])
    await user.click(await screen.findByRole('button', { name: 'Approach — SINGAPORE APPROACH 124.050 (RWY 02L)' }))

    expect(beyondAtcSetFrequency).toHaveBeenCalledWith('124.050')
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
