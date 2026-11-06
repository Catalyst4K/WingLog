import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusLight } from './StatusLight'

describe('StatusLight', () => {
  it('draws one dot in the colour of its state, hidden from screen readers', () => {
    const { container } = render(<StatusLight state="amber" />)
    const light = container.querySelector('[data-slot="status-light"]')
    expect(light).toHaveAttribute('aria-hidden', 'true')
    expect(light).toHaveAttribute('data-state', 'amber')
    expect(light?.children).toHaveLength(1)
    expect(light?.firstElementChild).toHaveClass('bg-light-amber')
  })

  it.each([
    ['green', 'bg-light-green'],
    ['red', 'bg-light-red'],
    ['off', 'bg-light-off']
  ] as const)('uses the %s light colour', (state, colour) => {
    const { container } = render(<StatusLight state={state} />)
    expect(container.querySelector('[data-slot="status-light"] > span')).toHaveClass(colour)
  })

  it('draws a row of dots for the sim connection', () => {
    const { container } = render(<StatusLight state="green" count={3} />)
    expect(container.querySelector('[data-slot="status-light"]')?.children).toHaveLength(3)
  })
})
