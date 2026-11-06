import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatCell, StatStrip } from './StatStrip'

describe('StatStrip', () => {
  it('is a row of label and figure cells, the figure in the mono face, with no cell added to fill it', () => {
    const { container } = render(
      <StatStrip>
        <StatCell label="Block time">1h 20m</StatCell>
        <StatCell label="Air time">1h 05m</StatCell>
      </StatStrip>
    )
    expect(container.querySelectorAll('dt')).toHaveLength(2)
    expect(container.querySelectorAll('dd')).toHaveLength(2)
    expect(screen.getByText('1h 20m')).toHaveClass('font-mono')
    expect(container.querySelector('dl')).toHaveClass('flex-wrap')
  })
})
