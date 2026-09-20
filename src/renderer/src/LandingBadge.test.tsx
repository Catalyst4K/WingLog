import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18n from './i18n'
import { LandingBadge } from './LandingBadge'

describe('LandingBadge', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

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

  it('shows the severity label in the active i18next language, not a hardcoded English string', async () => {
    await i18n.changeLanguage('de')
    render(<LandingBadge severity="hard" />)
    expect(screen.getByText('Hart')).toBeInTheDocument()
  })
})
