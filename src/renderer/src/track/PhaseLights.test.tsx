import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PhaseLights } from './TrackCards'

const states = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-slot="status-light"]')].map(
    (light) => light.getAttribute('data-state') ?? ''
  )

describe('PhaseLights', () => {
  it('lights the phases done green, the one it is in a larger ringed green dot, and those to come off', () => {
    const { container } = render(<PhaseLights phase="cruise" />)
    expect(states(container)).toEqual(['green', 'green', 'green', 'green', 'green', 'off', 'off', 'off'])
    const current = screen.getByText('cruise').closest('li')
    expect(current).toHaveAttribute('aria-current', 'step')
    // Only the phase it is in is named on screen; the others are for a screen reader.
    expect(screen.getByText('cruise')).not.toHaveClass('sr-only')
    expect(screen.getByText('taxi')).toHaveClass('sr-only')
  })

  it('has every light off before the flight has begun', () => {
    const { container } = render(<PhaseLights phase="preflight" />)
    expect(states(container)).toEqual(Array(8).fill('off'))
    expect(container.querySelector('[aria-current]')).toBeNull()
  })

  it('has every phase but the last done after shutdown begins', () => {
    const { container } = render(<PhaseLights phase="shutdown" />)
    expect(states(container).slice(-2)).toEqual(['green', 'green'])
    expect(screen.getByText('shutdown').closest('li')).toHaveAttribute('aria-current', 'step')
  })
})
