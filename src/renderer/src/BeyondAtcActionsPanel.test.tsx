import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BeyondAtcActionsPanel, type BeyondAtcActionsPanelProps } from './BeyondAtcActionsPanel'

function makeProps(overrides: Partial<BeyondAtcActionsPanelProps> = {}): BeyondAtcActionsPanelProps {
  return {
    actions: [],
    onSelectAction: vi.fn(),
    com1Frequency: null,
    com2Frequency: null,
    onSetFrequency: vi.fn(),
    onSetFrequencyCom2: vi.fn(),
    ...overrides
  }
}

describe('BeyondAtcActionsPanel', () => {
  it('renders nothing when there are no actions and no known frequencies', () => {
    const { container } = render(<BeyondAtcActionsPanel {...makeProps()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a button per live action, calling onSelectAction with the exact label', async () => {
    const onSelectAction = vi.fn()
    const user = userEvent.setup()
    render(
      <BeyondAtcActionsPanel
        {...makeProps({ actions: ['Request IFR Clearance', 'Radio Check'], onSelectAction })}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Radio Check' }))

    expect(onSelectAction).toHaveBeenCalledWith('Radio Check')
    expect(onSelectAction).not.toHaveBeenCalledWith('Request IFR Clearance')
  })

  it('shows the current COM1/COM2 frequencies read-only', () => {
    render(<BeyondAtcActionsPanel {...makeProps({ com1Frequency: '118.850', com2Frequency: '121.700' })} />)

    expect(screen.getByText('118.850')).toBeInTheDocument()
    expect(screen.getByText('121.700')).toBeInTheDocument()
  })

  it('typing a new COM1 frequency and clicking Set calls onSetFrequency, not onSetFrequencyCom2', async () => {
    const onSetFrequency = vi.fn()
    const onSetFrequencyCom2 = vi.fn()
    const user = userEvent.setup()
    render(<BeyondAtcActionsPanel {...makeProps({ com1Frequency: '118.850', onSetFrequency, onSetFrequencyCom2 })} />)

    const [com1Input] = screen.getAllByPlaceholderText('118.850')
    await user.type(com1Input, '119.100')
    await user.click(screen.getAllByRole('button', { name: 'Set' })[0])

    expect(onSetFrequency).toHaveBeenCalledWith('119.100')
    expect(onSetFrequencyCom2).not.toHaveBeenCalled()
  })

  it('pressing Enter in the COM2 frequency field commits it and clears the input', async () => {
    const onSetFrequencyCom2 = vi.fn()
    const user = userEvent.setup()
    render(<BeyondAtcActionsPanel {...makeProps({ com2Frequency: '121.700', onSetFrequencyCom2 })} />)

    const [, com2Input] = screen.getAllByPlaceholderText('118.850')
    await user.type(com2Input, '121.900{Enter}')

    expect(onSetFrequencyCom2).toHaveBeenCalledWith('121.900')
    expect(com2Input).toHaveValue('')
  })

  it('does not send an empty/whitespace-only frequency', async () => {
    const onSetFrequency = vi.fn()
    const user = userEvent.setup()
    render(<BeyondAtcActionsPanel {...makeProps({ com1Frequency: '118.850', onSetFrequency })} />)

    await user.click(screen.getAllByRole('button', { name: 'Set' })[0])

    expect(onSetFrequency).not.toHaveBeenCalled()
  })
})
