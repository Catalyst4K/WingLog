import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BeyondAtcFrequencyOption } from '@shared/ipc'
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
    stepClimb: { enabled: false, nextStep: null, pendingAltitudeFt: null, waitingForClimbFt: null, pastTopOfDescent: false, last: null },
    onSetStepClimb: vi.fn(),
    ...overrides
  }
}

function makeFrequencyOption(overrides: Partial<BeyondAtcFrequencyOption> = {}): BeyondAtcFrequencyOption {
  return {
    airport: 'WSSS',
    airportName: 'Changi',
    frequency: '124.050',
    name: 'SINGAPORE APPROACH',
    type: 'Approach',
    stationType: '',
    runways: '02L',
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
    render(<BeyondAtcActions actions={['Request IFR Clearance', 'Radio Check']} onSelectAction={onSelectAction} />)

    await user.click(screen.getByRole('button', { name: 'Radio Check' }))

    expect(onSelectAction).toHaveBeenCalledWith('Radio Check')
    expect(onSelectAction).not.toHaveBeenCalledWith('Request IFR Clearance')
  })
})

describe('BeyondAtcRadios', () => {
  it('shows "—" for COM1/COM2 while nothing is tuned', () => {
    render(<BeyondAtcRadios {...makeRadiosProps()} />)
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('shows the current COM1/COM2 station name and frequency together, not just the raw digits', () => {
    render(
      <BeyondAtcRadios
        {...makeRadiosProps({
          facility: { name: 'Brisbane Delivery', frequency: '118.850' },
          com2: { label: 'Brisbane Ground', frequency: '121.700', monitor: false }
        })}
      />
    )

    expect(screen.getByText('Brisbane Delivery (118.850)')).toBeInTheDocument()
    expect(screen.getByText('Brisbane Ground (121.700)')).toBeInTheDocument()
  })

  it('typing a new COM1 frequency and clicking Set calls onSetFrequency, not onSetFrequencyCom2', async () => {
    const onSetFrequency = vi.fn()
    const onSetFrequencyCom2 = vi.fn()
    const user = userEvent.setup()
    render(<BeyondAtcRadios {...makeRadiosProps({ onSetFrequency, onSetFrequencyCom2 })} />)

    const [com1Input] = screen.getAllByPlaceholderText('118.850')
    await user.type(com1Input, '119.100')
    await user.click(screen.getAllByRole('button', { name: 'Set' })[0])

    expect(onSetFrequency).toHaveBeenCalledWith('119.100')
    expect(onSetFrequencyCom2).not.toHaveBeenCalled()
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

  it('splits the real frequency list into Departure/Arrival tabs by matching Progress.from/to, runway shown next to the frequency it applies to', async () => {
    const onSetFrequency = vi.fn()
    const user = userEvent.setup()
    const options: BeyondAtcFrequencyOption[] = [
      makeFrequencyOption(), // WSSS, SINGAPORE APPROACH 124.050, runway 02L
      makeFrequencyOption({ airport: 'ZSPD', airportName: 'Pudong', frequency: '121.100', name: 'SHANGHAI APPROACH', runways: '34R' }),
      makeFrequencyOption({ airport: '', airportName: '', frequency: '134.400', name: 'Singapore Radar', type: 'Center', runways: '' })
    ]
    render(
      <BeyondAtcRadios
        {...makeRadiosProps({ frequencyOptions: options, progress: { from: 'WSSS', to: 'ZSPD', pct: 0 }, onSetFrequency })}
      />
    )

    await user.click(screen.getAllByRole('button', { name: 'Frequencies' })[0])
    // Departure tab (default): the WSSS station (with its runway) and the enroute Center
    // entry (no runway), but not the ZSPD-only station. Each button leads with the real
    // category (Approach/Center), not just BeyondATC's own station name.
    expect(await screen.findByRole('button', { name: 'Approach — SINGAPORE APPROACH 124.050 (RWY 02L)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Center — Singapore Radar 134.400' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /SHANGHAI APPROACH/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Arrival' }))
    await user.click(await screen.findByRole('button', { name: 'Approach — SHANGHAI APPROACH 121.100 (RWY 34R)' }))

    expect(onSetFrequency).toHaveBeenCalledWith('121.100')
  })

  it('leads a Clearance-type frequency with "Delivery" and an ATIS-type one with "ATIS", regardless of what BeyondATC named the station itself', async () => {
    const user = userEvent.setup()
    // Real captures: WSSS's own delivery/ATIS stations are named just "SINGAPORE"/"WSSS" —
    // no "Delivery" or "ATIS" anywhere in the name field itself.
    const options: BeyondAtcFrequencyOption[] = [
      makeFrequencyOption({ frequency: '121.650', name: 'SINGAPORE', type: 'Clearance', runways: '' }),
      makeFrequencyOption({ frequency: '128.600', name: 'WSSS', type: 'ATIS', runways: '' })
    ]
    render(<BeyondAtcRadios {...makeRadiosProps({ frequencyOptions: options, progress: { from: 'WSSS', to: 'ZSPD', pct: 0 } })} />)

    await user.click(screen.getAllByRole('button', { name: 'Frequencies' })[0])

    expect(await screen.findByRole('button', { name: 'Delivery — SINGAPORE 121.650' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ATIS — WSSS 128.600' })).toBeInTheDocument()
  })

  it('shows the current AutoTune/AutoRespond state and toggles them on click', async () => {
    const onSetAutoTune = vi.fn()
    const onSetAutoRespond = vi.fn()
    const user = userEvent.setup()
    render(<BeyondAtcRadios {...makeRadiosProps({ autoTune: true, autoRespond: false, onSetAutoTune, onSetAutoRespond })} />)

    expect(screen.getByRole('button', { name: 'Auto-tune: On' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Auto-respond: Off' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Auto-tune: On' }))
    await user.click(screen.getByRole('button', { name: 'Auto-respond: Off' }))

    expect(onSetAutoTune).toHaveBeenCalledWith(false)
    expect(onSetAutoRespond).toHaveBeenCalledWith(true)
  })
})

describe('BeyondAtcRadios — auto step climb', () => {
  const OFF = { enabled: false, nextStep: null, pendingAltitudeFt: null, waitingForClimbFt: null, pastTopOfDescent: false, last: null }

  it('toggles WingLog auto step climb on', async () => {
    const onSetStepClimb = vi.fn()
    render(<BeyondAtcRadios {...makeRadiosProps({ stepClimb: OFF, onSetStepClimb })} />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Auto step climb: Off' }))
    expect(onSetStepClimb).toHaveBeenCalledWith(true)
  })

  it('shows the next planned step once on', () => {
    render(
      <BeyondAtcRadios
        {...makeRadiosProps({ stepClimb: { ...OFF, enabled: true, nextStep: { ident: 'DENAK', altitudeFt: 35000, distanceNm: 42 } } })}
      />
    )
    expect(screen.getByRole('button', { name: 'Auto step climb: On' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Next step: FL350 at DENAK, 42 nm')).toBeInTheDocument()
  })

  it('shows a request in progress, then the result — including giving up after two tries', () => {
    const { rerender } = render(<BeyondAtcRadios {...makeRadiosProps({ stepClimb: { ...OFF, enabled: true, pendingAltitudeFt: 39000 } })} />)
    expect(screen.getByText('Requesting FL390…')).toBeInTheDocument()

    rerender(
      <BeyondAtcRadios
        {...makeRadiosProps({
          stepClimb: { ...OFF, enabled: true, last: { altitudeFt: 39000, outcome: 'granted', attempt: 1, reason: 'fcu', dropped: false } }
        })}
      />
    )
    expect(screen.getByText('FL390: cleared')).toBeInTheDocument()

    rerender(
      <BeyondAtcRadios
        {...makeRadiosProps({
          stepClimb: { ...OFF, enabled: true, last: { altitudeFt: 41000, outcome: 'notOffered', attempt: 2, reason: 'simbrief', dropped: true } }
        })}
      />
    )
    expect(screen.getByText('FL410: level not offered — gave up after two tries')).toBeInTheDocument()
  })

  it('says when an FCU level is waiting on the climb, and when top of descent has ended requests', () => {
    const { rerender } = render(
      <BeyondAtcRadios
        {...makeRadiosProps({
          stepClimb: { ...OFF, enabled: true, waitingForClimbFt: 41000, nextStep: { ident: 'KAMUD', altitudeFt: 43000, distanceNm: 300 } }
        })}
      />
    )
    expect(screen.getByText('FCU FL410 — waiting for the climb to start')).toBeInTheDocument()
    expect(screen.getByText('Next step: FL430 at KAMUD, 300 nm')).toBeInTheDocument()

    rerender(<BeyondAtcRadios {...makeRadiosProps({ stepClimb: { ...OFF, enabled: true, pastTopOfDescent: true } })} />)
    expect(screen.getByText('Past top of descent — no more requests this flight.')).toBeInTheDocument()
    expect(screen.queryByText(/Watching for a step climb/)).not.toBeInTheDocument()
  })

  it('says it is watching when on with nothing planned yet, and shows nothing when off', () => {
    const { rerender } = render(<BeyondAtcRadios {...makeRadiosProps({ stepClimb: { ...OFF, enabled: true } })} />)
    expect(screen.getByText('Watching for a step climb (SimBrief plan or FCU).')).toBeInTheDocument()
    rerender(<BeyondAtcRadios {...makeRadiosProps({ stepClimb: OFF })} />)
    expect(screen.queryByText(/Watching for a step climb/)).not.toBeInTheDocument()
  })
})
