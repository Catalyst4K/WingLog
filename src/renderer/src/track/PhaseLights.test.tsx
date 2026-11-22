import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '../i18n'
import { PhaseLights } from './PhaseLights'

const states = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-slot="status-light"]')].map(
    (light) => light.getAttribute('data-state') ?? ''
  )

describe('PhaseLights', () => {
  it('lights the phases done green, the one it is in a larger ringed green dot, and those to come off', () => {
    const { container } = render(<PhaseLights phase="cruise" />)
    expect(states(container)).toEqual([
      'green',
      'green',
      'green',
      'green',
      'green',
      'off',
      'off',
      'off',
      'off'
    ])
    const current = screen.getByText('Cruise').closest('li')
    expect(current).toHaveAttribute('aria-current', 'step')
    // Only the phase it is in is named on screen; the others are for a screen reader.
    expect(screen.getByText('Cruise')).not.toHaveClass('sr-only')
    expect(screen.getByText('Taxi out')).toHaveClass('sr-only')
    expect(screen.getByText('Taxi in')).toHaveClass('sr-only')
  })

  it('has every light off before the flight has begun', () => {
    const { container } = render(<PhaseLights phase="preflight" />)
    expect(states(container)).toEqual(Array(9).fill('off'))
    expect(container.querySelector('[aria-current]')).toBeNull()
  })

  it('has every phase but the last done after shutdown begins', () => {
    const { container } = render(<PhaseLights phase="shutdown" pastLanding />)
    expect(states(container).slice(-2)).toEqual(['green', 'green'])
    expect(screen.getByText('Shutdown').closest('li')).toHaveAttribute('aria-current', 'step')
  })

  it('before takeoff, taxi is the second light and reads "Taxi out"', () => {
    const { container } = render(<PhaseLights phase="taxi" />)
    const items = [...container.querySelectorAll('li')]
    expect(items[1]).toHaveAttribute('aria-current', 'step')
    expect(items[1]).toHaveTextContent('Taxi out')
    expect(states(container)).toEqual(['green', 'green', 'off', 'off', 'off', 'off', 'off', 'off', 'off'])
  })

  it('after a landing, taxi is the eighth light and reads "Taxi in", with Pushback to Landing done', () => {
    const { container } = render(<PhaseLights phase="taxi" pastLanding />)
    const items = [...container.querySelectorAll('li')]
    expect(items).toHaveLength(9)
    expect(items[7]).toHaveAttribute('aria-current', 'step')
    expect(items[7]).toHaveTextContent('Taxi in')
    expect(items.filter((item) => item.hasAttribute('aria-current'))).toHaveLength(1)
    expect(states(container)).toEqual(Array(8).fill('green').concat('off'))
    expect(screen.getByText('Taxi out')).toHaveClass('sr-only')
  })

  it('is told apart from the past-landing flag only for taxi: other phases ignore it', () => {
    render(<PhaseLights phase="descent" pastLanding />)
    expect(screen.getByText('Descent').closest('li')).toHaveAttribute('aria-current', 'step')
  })
})
