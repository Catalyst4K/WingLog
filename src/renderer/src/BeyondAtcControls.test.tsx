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

    expect(screen.queryByRole('button', { name: 'Choose a frequency…' })).not.toBeInTheDocument()
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

    await user.click(screen.getAllByRole('button', { name: 'Choose a frequency…' })[0])
    // Departure tab (default): the WSSS station (with its runway) and the enroute Center
    // entry (no runway), but not the ZSPD-only station.
    expect(await screen.findByRole('button', { name: 'SINGAPORE APPROACH 124.050 (RWY 02L)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Singapore Radar 134.400' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /SHANGHAI APPROACH/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Arrival' }))
    await user.click(await screen.findByRole('button', { name: 'SHANGHAI APPROACH 121.100 (RWY 34R)' }))

    expect(onSetFrequency).toHaveBeenCalledWith('121.100')
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
