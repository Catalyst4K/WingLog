import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BeyondAtcFrequencyOption } from '@shared/ipc'
import { BeyondAtcActions, BeyondAtcRadios, type BeyondAtcRadiosProps } from './BeyondAtcControls'

function makeRadiosProps(overrides: Partial<BeyondAtcRadiosProps> = {}): BeyondAtcRadiosProps {
  return {
    facility: null,
    com2: null,
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

  it('does not show a frequency picker when no options are known, only manual entry', () => {
    render(<BeyondAtcRadios {...makeRadiosProps()} />)

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('picking a frequency from the real BeyondATC list calls onSetFrequency with its value', async () => {
    const onSetFrequency = vi.fn()
    const user = userEvent.setup()
    const options: BeyondAtcFrequencyOption[] = [
      makeFrequencyOption(),
      makeFrequencyOption({ airport: '', airportName: '', frequency: '134.400', name: 'Singapore Radar', type: 'Center' })
    ]
    render(<BeyondAtcRadios {...makeRadiosProps({ frequencyOptions: options, onSetFrequency })} />)

    await user.click(screen.getAllByRole('combobox')[0])
    expect(screen.getByText('Changi')).toBeInTheDocument()
    expect(screen.getByText('Enroute')).toBeInTheDocument()
    await user.click(await screen.findByRole('option', { name: 'SINGAPORE APPROACH 124.050' }))

    expect(onSetFrequency).toHaveBeenCalledWith('124.050')
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
