import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LandingScoreBadge } from './LandingScoreBadge'

describe('LandingScoreBadge', () => {
  it('renders a dash for a missing score rather than a fabricated number', () => {
    render(<LandingScoreBadge score={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders the numeric score for a good landing', () => {
    render(<LandingScoreBadge score={92} />)
    expect(screen.getByText('92')).toBeInTheDocument()
  })

  it('renders the numeric score for a fair landing', () => {
    render(<LandingScoreBadge score={65} />)
    expect(screen.getByText('65')).toBeInTheDocument()
  })

  it('renders the numeric score for a poor landing', () => {
    render(<LandingScoreBadge score={20} />)
    expect(screen.getByText('20')).toBeInTheDocument()
  })

  it('renders 0 for a genuinely dangerous landing, not a dash', () => {
    render(<LandingScoreBadge score={0} />)
    expect(screen.getByText('0')).toBeInTheDocument()
  })
})
