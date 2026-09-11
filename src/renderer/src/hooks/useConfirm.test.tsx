import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useConfirm } from './useConfirm'

function Harness(props: { destructive?: boolean }): React.JSX.Element {
  const [confirm, dialog] = useConfirm()
  const [result, setResult] = useState<string>('none')

  async function ask(): Promise<void> {
    const confirmed = await confirm({
      title: 'Delete this flight?',
      description: 'This cannot be undone.',
      confirmLabel: 'Delete flight',
      destructive: props.destructive
    })
    setResult(confirmed ? 'confirmed' : 'cancelled')
  }

  return (
    <div>
      <button onClick={() => void ask()}>Ask</button>
      <span>result: {result}</span>
      {dialog}
    </div>
  )
}

describe('useConfirm', () => {
  it('renders no dialog content until confirm() is called', () => {
    render(<Harness />)
    expect(screen.queryByText('Delete this flight?')).not.toBeInTheDocument()
  })

  it('resolves true when the confirm button is clicked', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByText('Ask'))
    expect(screen.getByText('Delete this flight?')).toBeInTheDocument()
    await user.click(screen.getByText('Delete flight'))

    expect(await screen.findByText('result: confirmed')).toBeInTheDocument()
  })

  it('resolves false when the cancel button is clicked', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByText('Ask'))
    await user.click(screen.getByText('Back'))

    expect(await screen.findByText('result: cancelled')).toBeInTheDocument()
  })

  it('resolves false when dismissed without an explicit choice (e.g. Escape)', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByText('Ask'))
    await user.keyboard('{Escape}')

    expect(await screen.findByText('result: cancelled')).toBeInTheDocument()
  })

  it('uses a custom cancel label when given', async () => {
    function CustomLabelHarness(): React.JSX.Element {
      const [confirm, dialog] = useConfirm()
      return (
        <div>
          <button onClick={() => void confirm({ title: 'T', description: 'D', confirmLabel: 'Go', cancelLabel: 'Nope' })}>
            Ask
          </button>
          {dialog}
        </div>
      )
    }
    const user = userEvent.setup()
    render(<CustomLabelHarness />)

    await user.click(screen.getByText('Ask'))

    expect(screen.getByText('Nope')).toBeInTheDocument()
  })

  it('supports back-to-back confirmations, each resolving independently', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByText('Ask'))
    await user.click(screen.getByText('Delete flight'))
    expect(await screen.findByText('result: confirmed')).toBeInTheDocument()

    await user.click(screen.getByText('Ask'))
    await user.click(screen.getByText('Back'))
    expect(await screen.findByText('result: cancelled')).toBeInTheDocument()
  })
})
