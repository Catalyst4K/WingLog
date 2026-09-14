import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { NavigraphLogo } from './NavigraphLogo'

describe('NavigraphLogo', () => {
  it('renders an svg mark, hidden from assistive tech', () => {
    const { container } = render(<NavigraphLogo />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
  })

  it('applies a passed-through className', () => {
    const { container } = render(<NavigraphLogo className="size-6" />)
    expect(container.querySelector('svg')).toHaveClass('size-6')
  })
})
