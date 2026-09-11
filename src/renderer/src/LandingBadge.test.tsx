import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LandingBadge } from './LandingBadge'

describe('LandingBadge', () => {
  it('renders nothing for a normal landing', () => {
    const { container } = render(<LandingBadge severity="none" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows "Firm" for a firm landing', () => {
    render(<LandingBadge severity="firm" />)
    expect(screen.getByText('Firm')).toBeInTheDocument()
  })

  it('shows "Hard" for a hard landing', () => {
    render(<LandingBadge severity="hard" />)
    expect(screen.getByText('Hard')).toBeInTheDocument()
  })
})
