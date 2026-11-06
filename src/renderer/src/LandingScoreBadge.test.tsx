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

  it('tints the pill green for a good landing, amber for a fair one and red for a poor one', () => {
    const tint = (score: number): string => {
      const { unmount } = render(<LandingScoreBadge score={score} />)
      const className = screen.getByText(String(score)).className
      unmount()
      return className
    }
    expect(tint(92)).toContain('bg-light-green')
    expect(tint(80)).toContain('bg-light-green')
    expect(tint(65)).toContain('bg-light-amber')
    expect(tint(20)).toContain('bg-light-red')
    expect(tint(0)).toContain('bg-light-red')
  })
})
