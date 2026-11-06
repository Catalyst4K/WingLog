import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetUiMemory, uiMemory } from '../ui-memory'
import { MapKey } from './MapKey'

describe('MapKey', () => {
  beforeEach(() => resetUiMemory())

  it('is closed by default, a small Key button', () => {
    render(<MapKey />)
    expect(screen.getByRole('button', { name: 'Key' })).toBeInTheDocument()
    expect(screen.queryByText('Flown track')).not.toBeInTheDocument()
  })

  it('opens to list the lines and fix symbols, and hides again', async () => {
    const user = userEvent.setup()
    render(<MapKey />)
    await user.click(screen.getByRole('button', { name: 'Key' }))
    for (const label of [
      'Flown track',
      'Plan',
      'Taxi route',
      'ATC centre (tinted)',
      'Approach area (outline only)',
      'Airport with ATC (D G T A I: delivery, ground, tower, approach, ATIS)',
      'Fix',
      'SID or STAR fix',
      'Approach fix'
    ])
      expect(screen.getByText(label)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByText('Flown track')).not.toBeInTheDocument()
  })

  it('remembers the choice with the other map settings, so a remount keeps it open', async () => {
    const user = userEvent.setup()
    const first = render(<MapKey />)
    await user.click(screen.getByRole('button', { name: 'Key' }))
    expect(uiMemory().mapKeyOpen).toBe(true)
    first.unmount()
    render(<MapKey />)
    expect(screen.getByText('Flown track')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(uiMemory().mapKeyOpen).toBe(false)
  })
})
