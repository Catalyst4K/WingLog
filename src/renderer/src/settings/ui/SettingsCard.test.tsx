import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OnOffControl, SettingRow, SettingsCard, SettingsSection, StatusBadge } from './SettingsCard'
import { Input } from '@/components/ui/input'

describe('SettingsCard', () => {
  it('is one fixed width, with the title, status badge and description in the header and the rows in the body', () => {
    render(
      <SettingsCard
        title="GSX Remote Control"
        status={<StatusBadge state="connected" label="Connected" />}
        description="Live ground-service control."
      >
        <SettingRow label="Host">
          <span>127.0.0.1</span>
        </SettingRow>
      </SettingsCard>
    )
    const card = screen.getByText('GSX Remote Control').closest('[data-slot="card"]') as HTMLElement
    expect(card).toHaveClass('w-full', 'max-w-2xl')
    const header = within(card)
    expect(header.getByText('Connected')).toBeInTheDocument()
    expect(header.getByText('Live ground-service control.')).toBeInTheDocument()
    expect(header.getByText('Host')).toBeInTheDocument()
  })

  it('draws no body for a card that is still loading, and no footer unless it has actions', () => {
    render(<SettingsCard title="Second screen" />)
    const card = screen.getByText('Second screen').closest('[data-slot="card"]') as HTMLElement
    expect(card.querySelector('[data-slot="card-content"]')).toBeNull()
  })

  it('puts the footer actions in the card', () => {
    render(
      <SettingsCard title="About" footer={<button type="button">Open manual</button>}>
        <p>text</p>
      </SettingsCard>
    )
    expect(screen.getByRole('button', { name: 'Open manual' })).toBeInTheDocument()
  })
})

describe('SettingRow', () => {
  it('ties the label to its field, and shows a note under the label', async () => {
    render(
      <SettingRow label="Port" note="8744 is GSX's default." controlId="port-field">
        <Input id="port-field" />
      </SettingRow>
    )
    expect(screen.getByRole('textbox', { name: 'Port' })).toBeInTheDocument()
    expect(screen.getByText("8744 is GSX's default.")).toBeInTheDocument()
  })

  it('keeps a wide control on its own line when it is stacked, and a short one beside the label otherwise', () => {
    const { container, rerender } = render(
      <SettingRow label="A">
        <span>control</span>
      </SettingRow>
    )
    expect(container.querySelector('.basis-full')).toBeNull()
    rerender(
      <SettingRow label="A" stacked>
        <span>control</span>
      </SettingRow>
    )
    expect(container.querySelector('.basis-full')).not.toBeNull()
  })

  it('can mark its label as a live status line', () => {
    render(
      <SettingRow label="Up to date" labelRole="status">
        <span />
      </SettingRow>
    )
    expect(screen.getByRole('status')).toHaveTextContent('Up to date')
  })
})

describe('OnOffControl', () => {
  it('shows which side is on, and reports the side that is pressed', async () => {
    const onChange = vi.fn()
    render(<OnOffControl label="Enabled" enabled={false} onText="On" offText="Off" onChange={onChange} />)
    const group = screen.getByRole('group', { name: 'Enabled' })
    expect(within(group).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(within(group).getByRole('button', { name: 'On' }))
    expect(onChange).toHaveBeenCalledWith(true)
    await userEvent.click(within(group).getByRole('button', { name: 'Off' }))
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('cannot be pressed while disabled', () => {
    render(<OnOffControl label="Enabled" enabled disabled onText="On" offText="Off" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Off' })).toBeDisabled()
  })
})

describe('StatusBadge', () => {
  it('shows its text for every state', () => {
    render(
      <>
        {(['connected', 'connecting', 'disconnected', 'error'] as const).map((state) => (
          <StatusBadge key={state} state={state} label={state} />
        ))}
      </>
    )
    for (const state of ['connected', 'connecting', 'disconnected', 'error']) {
      expect(screen.getByText(state)).toBeInTheDocument()
    }
  })
})

describe('SettingsSection', () => {
  it('is a labelled region with a heading and actions beside it', () => {
    render(
      <SettingsSection title="Fleet" ariaLabel="Fleet data" action={<button type="button">Import</button>}>
        <p>rows</p>
      </SettingsSection>
    )
    const region = screen.getByRole('region', { name: 'Fleet data' })
    expect(within(region).getByRole('heading', { name: 'Fleet' })).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Import' })).toBeInTheDocument()
  })

  it('is named by its title when no other name is given', () => {
    render(
      <SettingsSection title="Fleet">
        <p>rows</p>
      </SettingsSection>
    )
    expect(screen.getByRole('region', { name: 'Fleet' })).toBeInTheDocument()
  })
})
