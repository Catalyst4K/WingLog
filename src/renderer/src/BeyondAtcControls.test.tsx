import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BeyondAtcFrequencyOption } from '@shared/ipc'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { BeyondAtcActions, BeyondAtcRadios, type BeyondAtcRadiosProps } from './BeyondAtcControls'

function makeRadiosProps(overrides: Partial<BeyondAtcRadiosProps> = {}): BeyondAtcRadiosProps {
  return {
    facility: null,
    com2: null,
    progress: null,
    onSetFrequency: vi.fn(),
    onSetFrequencyCom2: vi.fn(),
    frequencyOptions: [],
    autoTune: null,
    autoRespond: null,
    onSetAutoTune: vi.fn(),
    onSetAutoRespond: vi.fn(),
    stepClimb: {
      enabled: false,
      nextStep: null,
      pendingAltitudeFt: null,
      waitingForClimbFt: null,
      pastTopOfDescent: false,
      last: null
    },
    onSetStepClimb: vi.fn(),
    ...overrides
  }
}

describe('BeyondAtcActions', () => {
  it('renders nothing when there are no live actions', () => {
    const { container } = render(<BeyondAtcActions actions={[]} onSelectAction={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a button per live action, calling onSelectAction with the exact label', async () => {
    const onSelectAction = vi.fn()
    const user = userEvent.setup()
    render(
      <BeyondAtcActions actions={['Request IFR Clearance', 'Radio Check']} onSelectAction={onSelectAction} />
    )

    await user.click(screen.getByRole('button', { name: 'Radio Check' }))

    expect(onSelectAction).toHaveBeenCalledWith('Radio Check')
    expect(onSelectAction).not.toHaveBeenCalledWith('Request IFR Clearance')
  })
})

describe('BeyondAtcRadios while the pilot is online', () => {
  /** The online status, and a connected BeyondATC whose live state has `autoTune`. */
  function withStatus(hidesBeyondAtc: boolean, autoTune: boolean | null = null): void {
    window.winglog = {
      getOnlineStatus: vi.fn().mockResolvedValue({
        network: 'ivao',
        state: hidesBeyondAtc ? 'online' : 'offline',
        callsign: null,
        filedPlan: null,
        hidesBeyondAtc
      }),
      onOnlineStatus: vi.fn(() => () => {}),
      beyondAtcGetStatus: vi.fn().mockResolvedValue({ state: 'connected', lastError: null }),
      onBeyondAtcStatus: vi.fn(() => () => {}),
      beyondAtcGetState: vi.fn().mockResolvedValue({ ...EMPTY_BEYONDATC_STATE, autoTune }),
      onBeyondAtcState: vi.fn(() => () => {})
    } as unknown as typeof window.winglog
  }

  it("warns while BeyondATC's auto-tune is on, and leaves switching it off to the pilot", async () => {
    withStatus(true, true)
    const onSetAutoTune = vi.fn()
    render(<BeyondAtcRadios {...makeRadiosProps({ autoTune: true, onSetAutoTune })} />)
    expect(await screen.findByRole('alert')).toHaveTextContent("BeyondATC's auto-tune is on")
    expect(screen.getByRole('button', { name: 'Auto-tune: On' })).toBeInTheDocument()
    expect(onSetAutoTune).not.toHaveBeenCalled()
  })

  it('replaces the frequency picker with the note, and keeps the toggles', async () => {
    withStatus(true)
    render(<BeyondAtcRadios {...makeRadiosProps({ autoTune: true, autoRespond: false })} />)
    expect(await screen.findByText(/BeyondATC is hidden while you are online on IVAO/)).toBeInTheDocument()
    expect(screen.queryByText('COM1')).not.toBeInTheDocument()
    expect(screen.queryByText('COM2')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Auto-tune/ })).toBeInTheDocument()
  })

  it('shows COM1 and COM2 as usual when the pilot is offline', async () => {
    withStatus(false)
    render(<BeyondAtcRadios {...makeRadiosProps()} />)
    expect(await screen.findByText('COM1')).toBeInTheDocument()
    expect(screen.queryByText(/BeyondATC is hidden/)).not.toBeInTheDocument()
  })
})

describe('BeyondAtcRadios', () => {
  it('shows "—" for COM1/COM2 while nothing is tuned', () => {
    render(<BeyondAtcRadios {...makeRadiosProps()} />)
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('shows the tuned station name beside the radio and its frequency in the field, not both in the text', () => {
    render(
      <BeyondAtcRadios
        {...makeRadiosProps({
          facility: { name: 'Brisbane Delivery', frequency: '118.850' },
          com2: { label: 'Brisbane Ground', frequency: '121.700', monitor: false }
        })}
      />
    )

    expect(screen.getByText('Brisbane Delivery')).toBeInTheDocument()
    expect(screen.getByText('Brisbane Ground')).toBeInTheDocument()
    expect(screen.queryByText(/118\.850/)).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'COM1 frequency' })).toHaveValue('118.850')
    expect(screen.getByRole('textbox', { name: 'COM2 frequency' })).toHaveValue('121.700')
  })

  it('follows the tuned frequency when it changes, and leaves a frequency being typed alone until it is set or the row is left', async () => {
    const user = userEvent.setup()
    const onSetFrequency = vi.fn()
    const { rerender } = render(
      <BeyondAtcRadios
        {...makeRadiosProps({ facility: { name: 'Singapore Radar', frequency: '133.250' }, onSetFrequency })}
      />
    )
    const field = screen.getByRole('textbox', { name: 'COM1 frequency' })
    expect(field).toHaveValue('133.250')

    // BeyondATC tunes the next station: the field follows.
    rerender(
      <BeyondAtcRadios
        {...makeRadiosProps({ facility: { name: 'Singapore Radar', frequency: '134.400' }, onSetFrequency })}
      />
    )
    expect(field).toHaveValue('134.400')

    // Part-way through typing, a change from BeyondATC does not overwrite what is typed.
    await user.clear(field)
    await user.type(field, '119.1')
    rerender(
      <BeyondAtcRadios
        {...makeRadiosProps({
          facility: { name: 'Singapore Approach', frequency: '124.050' },
          onSetFrequency
        })}
      />
    )
    expect(field).toHaveValue('119.1')

    // Moving on to this radio's Set button keeps what was typed, so it can be set.
    await user.tab()
    expect(field).toHaveValue('119.1')

    // Leaving the row abandons the edit and shows the tuned frequency again.
    await user.click(document.body)
    expect(field).toHaveValue('124.050')
    expect(onSetFrequency).not.toHaveBeenCalled()
  })

  it('typing a new COM1 frequency and clicking Set calls onSetFrequency, not onSetFrequencyCom2', async () => {
    const onSetFrequency = vi.fn()
    const onSetFrequencyCom2 = vi.fn()
    const user = userEvent.setup()
    render(<BeyondAtcRadios {...makeRadiosProps({ onSetFrequency, onSetFrequencyCom2 })} />)

    await user.type(screen.getByRole('textbox', { name: 'COM1 frequency' }), '119.100')
    await user.click(screen.getAllByRole('button', { name: 'Set' })[0])

    expect(onSetFrequency).toHaveBeenCalledWith('119.100')
    expect(onSetFrequencyCom2).not.toHaveBeenCalled()
  })

  it('does not re-send the frequency that is already tuned', async () => {
    const onSetFrequency = vi.fn()
    const user = userEvent.setup()
    render(
      <BeyondAtcRadios
        {...makeRadiosProps({ facility: { name: 'Singapore Radar', frequency: '133.250' }, onSetFrequency })}
      />
    )
    await user.click(screen.getAllByRole('button', { name: 'Set' })[0])
    expect(onSetFrequency).not.toHaveBeenCalled()
  })

  it('shows a switched-off COM2 as "Radio Off", not with empty brackets', () => {
    // BeyondATC's real line for a switched-off COM2: Com2: {"label":"Radio Off","frequency":"","monitor":false}
    render(
      <BeyondAtcRadios
        {...makeRadiosProps({ com2: { label: 'Radio Off', frequency: '', monitor: false } })}
      />
    )
    expect(screen.getByText('Radio Off')).toBeInTheDocument()
    expect(screen.queryByText(/Radio Off \(/)).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'COM2 frequency' })).toHaveValue('')
  })

  it('pressing Enter in the COM2 frequency field commits it and clears the input', async () => {
    const onSetFrequencyCom2 = vi.fn()
    const user = userEvent.setup()
    render(<BeyondAtcRadios {...makeRadiosProps({ onSetFrequencyCom2 })} />)

    const [, com2Input] = screen.getAllByPlaceholderText('118.850')
    await user.type(com2Input, '121.900{Enter}')

    expect(onSetFrequencyCom2).toHaveBeenCalledWith('121.900')
    expect(com2Input).toHaveValue('')
  })

  it('does not send an empty/whitespace-only frequency', async () => {
    const onSetFrequency = vi.fn()
    const user = userEvent.setup()
    render(<BeyondAtcRadios {...makeRadiosProps({ onSetFrequency })} />)

    await user.click(screen.getAllByRole('button', { name: 'Set' })[0])

    expect(onSetFrequency).not.toHaveBeenCalled()
  })

  it('does not show a frequency picker button when no options are known, only manual entry', () => {
    render(<BeyondAtcRadios {...makeRadiosProps()} />)

    expect(screen.queryByRole('button', { name: 'Frequencies' })).not.toBeInTheDocument()
  })

  describe('the frequency dialog', () => {
    // Flight 236's lists (EGLL-WSSS), shortened: capitals, no runways in the list itself.
    const option = (
      airport: string,
      airportName: string,
      type: string,
      frequency: string,
      name: string,
      runways = ''
    ): BeyondAtcFrequencyOption => ({ airport, airportName, frequency, name, type, stationType: '', runways })
    const LIST: BeyondAtcFrequencyOption[] = [
      option('EGLL', 'Heathrow', 'Approach', '119.730', 'HEATHROW DIRECTOR'),
      option('EGLL', 'Heathrow', 'Tower', '118.705', 'HEATHROW TOWER'),
      option('EGLL', 'Heathrow', 'Ground', '121.705', 'HEATHROW GROUND'),
      option('EGLL', 'Heathrow', 'Clearance', '121.980', 'HEATHROW DELIVERY'),
      option('', '', 'Center', '120.530', 'London Control'),
      option('WSSS', 'Changi', 'Tower', '118.250', 'SINGAPORE TOWER'),
      option('WSSS', 'Changi', 'Tower', '118.600', 'SINGAPORE TOWER', '20R'),
      option('WSSS', 'Changi', 'Clearance', '121.650', 'SINGAPORE'),
      option('WSSS', 'Changi', 'ATIS', '128.600', 'WSSS')
    ]
    const open = async (
      overrides: Partial<BeyondAtcRadiosProps> = {}
    ): Promise<ReturnType<typeof userEvent.setup>> => {
      const user = userEvent.setup()
      render(
        <BeyondAtcRadios
          {...makeRadiosProps({
            frequencyOptions: LIST,
            progress: { from: 'EGLL', to: 'WSSS', pct: 10 },
            ...overrides
          })}
        />
      )
      await user.click(screen.getAllByRole('button', { name: 'Frequencies' })[0])
      return user
    }

    it('opens on the departure in the first half of the flight and lists its stations by type, in the order a flight uses them', async () => {
      await open()
      const headings = (await screen.findAllByRole('heading', { level: 3 })).map((h) => h.textContent)
      // Delivery, Ground, Tower, Approach, then the en-route entry's own heading last.
      expect(headings).toEqual(['Delivery', 'Ground', 'Tower', 'Approach', 'Center'])
      expect(screen.getByRole('button', { name: /Heathrow Tower\s+118\.705/ })).toBeInTheDocument()
      expect(screen.getByText('EGLL Heathrow')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Singapore Tower/ })).not.toBeInTheDocument()
    })

    it('opens on the arrival in the second half of the flight', async () => {
      await open({ progress: { from: 'EGLL', to: 'WSSS', pct: 80 } })
      expect(await screen.findByText('WSSS Changi')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Singapore Tower\s+118\.250/ })).toBeInTheDocument()
    })

    it('reads station names as words and leaves a code like WSSS alone', async () => {
      await open({ progress: { from: 'EGLL', to: 'WSSS', pct: 80 } })
      expect(await screen.findByRole('button', { name: /^Singapore\s+121\.650/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^WSSS\s+128\.600/ })).toBeInTheDocument()
    })

    it('shows the runways beside the stations that have them, and tells two towers apart by them', async () => {
      await open({ progress: { from: 'EGLL', to: 'WSSS', pct: 80 } })
      const towers = await screen.findAllByRole('button', { name: /Singapore Tower/ })
      expect(towers).toHaveLength(2)
      expect(towers[0]).not.toHaveTextContent('RWY')
      expect(towers[1]).toHaveTextContent('RWY 20R')
      expect(towers[1]).toHaveTextContent('118.600')
    })

    it('marks the station that is tuned now, matching 133.9 to 133.900', async () => {
      await open({
        facility: { name: 'Singapore Tower (20R)', frequency: '118.6' },
        progress: { from: 'EGLL', to: 'WSSS', pct: 80 }
      })
      const tuned = await screen.findByRole('button', { name: /118\.600/ })
      expect(tuned).toHaveAttribute('aria-current', 'true')
      expect(tuned).toHaveTextContent('Tuned')
      expect(screen.getByRole('button', { name: /118\.250/ })).not.toHaveAttribute('aria-current')
    })

    it('has a tab for each airport, and picking a station sets the frequency and closes the dialog', async () => {
      const onSetFrequency = vi.fn()
      const user = await open({ onSetFrequency })
      await user.click(await screen.findByRole('tab', { name: 'Arrival' }))
      await user.click(await screen.findByRole('button', { name: /Singapore Tower.*118\.600/ }))
      expect(onSetFrequency).toHaveBeenCalledWith('118.600')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('says so when BeyondATC has listed nothing for the airport, and still shows the en-route stations', async () => {
      await open({ progress: { from: 'ZZZZ', to: 'WSSS', pct: 10 } })
      expect(await screen.findByText('No frequencies for this airport yet.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /London Control\s+120\.530/ })).toBeInTheDocument()
    })
  })

  it('shows the current AutoTune/AutoRespond state and toggles them on click', async () => {
    const onSetAutoTune = vi.fn()
    const onSetAutoRespond = vi.fn()
    const user = userEvent.setup()
    render(
      <BeyondAtcRadios
        {...makeRadiosProps({ autoTune: true, autoRespond: false, onSetAutoTune, onSetAutoRespond })}
      />
    )

    expect(screen.getByRole('button', { name: 'Auto-tune: On' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Auto-respond: Off' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Auto-tune: On' }))
    await user.click(screen.getByRole('button', { name: 'Auto-respond: Off' }))

    expect(onSetAutoTune).toHaveBeenCalledWith(false)
    expect(onSetAutoRespond).toHaveBeenCalledWith(true)
  })
})

describe('BeyondAtcRadios — auto step climb', () => {
  const OFF = {
    enabled: false,
    nextStep: null,
    pendingAltitudeFt: null,
    waitingForClimbFt: null,
    pastTopOfDescent: false,
    last: null
  }

  it('toggles WingLog auto step climb on', async () => {
    const onSetStepClimb = vi.fn()
    render(<BeyondAtcRadios {...makeRadiosProps({ stepClimb: OFF, onSetStepClimb })} />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Auto step climb: Off' }))
    expect(onSetStepClimb).toHaveBeenCalledWith(true)
  })

  it('shows the next planned step once on', () => {
    render(
      <BeyondAtcRadios
        {...makeRadiosProps({
          stepClimb: {
            ...OFF,
            enabled: true,
            nextStep: { ident: 'DENAK', altitudeFt: 35000, distanceNm: 42 }
          }
        })}
      />
    )
    expect(screen.getByRole('button', { name: 'Auto step climb: On' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByText('Next step: FL350 at DENAK, 42 nm')).toBeInTheDocument()
  })

  it('shows a request in progress, then the result — including giving up after two tries', () => {
    const { rerender } = render(
      <BeyondAtcRadios
        {...makeRadiosProps({ stepClimb: { ...OFF, enabled: true, pendingAltitudeFt: 39000 } })}
      />
    )
    expect(screen.getByText('Requesting FL390…')).toBeInTheDocument()

    rerender(
      <BeyondAtcRadios
        {...makeRadiosProps({
          stepClimb: {
            ...OFF,
            enabled: true,
            last: { altitudeFt: 39000, outcome: 'granted', attempt: 1, reason: 'fcu', dropped: false }
          }
        })}
      />
    )
    expect(screen.getByText('FL390: cleared')).toBeInTheDocument()

    rerender(
      <BeyondAtcRadios
        {...makeRadiosProps({
          stepClimb: {
            ...OFF,
            enabled: true,
            last: { altitudeFt: 41000, outcome: 'notOffered', attempt: 2, reason: 'simbrief', dropped: true }
          }
        })}
      />
    )
    expect(screen.getByText('FL410: level not offered — gave up after two tries')).toBeInTheDocument()
  })

  it('says when an FCU level is waiting on the climb, and when top of descent has ended requests', () => {
    const { rerender } = render(
      <BeyondAtcRadios
        {...makeRadiosProps({
          stepClimb: {
            ...OFF,
            enabled: true,
            waitingForClimbFt: 41000,
            nextStep: { ident: 'KAMUD', altitudeFt: 43000, distanceNm: 300 }
          }
        })}
      />
    )
    expect(screen.getByText('FCU FL410 — waiting for the climb to start')).toBeInTheDocument()
    expect(screen.getByText('Next step: FL430 at KAMUD, 300 nm')).toBeInTheDocument()

    rerender(
      <BeyondAtcRadios
        {...makeRadiosProps({ stepClimb: { ...OFF, enabled: true, pastTopOfDescent: true } })}
      />
    )
    expect(screen.getByText('Past top of descent — no more requests this flight.')).toBeInTheDocument()
    expect(screen.queryByText(/Watching for a step climb/)).not.toBeInTheDocument()
  })

  it('says it is watching when on with nothing planned yet, and shows nothing when off', () => {
    const { rerender } = render(
      <BeyondAtcRadios {...makeRadiosProps({ stepClimb: { ...OFF, enabled: true } })} />
    )
    expect(screen.getByText('Watching for a step climb (SimBrief plan or FCU).')).toBeInTheDocument()
    rerender(<BeyondAtcRadios {...makeRadiosProps({ stepClimb: OFF })} />)
    expect(screen.queryByText(/Watching for a step climb/)).not.toBeInTheDocument()
  })
})
