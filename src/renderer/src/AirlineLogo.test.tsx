import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { AirlineLogo } from './AirlineLogo'
import { badgeHue, logoSrc } from './airline-logo-src'

describe('AirlineLogo', () => {
  it('renders nothing when there is no IATA code', () => {
    const { container } = render(<AirlineLogo iata={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders an image pointed at the logo service for the given IATA code', () => {
    // alt="" is deliberate (decorative image), which gives the <img> an implicit
    // "presentation" role rather than "img" — query by tag instead of role.
    const { container } = render(<AirlineLogo iata="BA" />)
    const img = container.querySelector('img')
    expect(img).toHaveAttribute('src', 'https://images.kiwi.com/airlines/32/BA.png')
  })

  it('swaps in a badge showing the IATA code when the image fails to load', () => {
    const { container, getByTestId } = render(<AirlineLogo iata="zz" />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(getByTestId('airline-logo-badge')).toHaveTextContent('ZZ')
  })

  it('retries the image for a different airline after a failure', () => {
    const { container, rerender } = render(<AirlineLogo iata="ZZ" />)
    fireEvent.error(container.querySelector('img')!)
    rerender(<AirlineLogo iata="BA" />)
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://images.kiwi.com/airlines/32/BA.png'
    )
  })
})

describe('logoSrc', () => {
  it('prefers a bundled logo over the image service', () => {
    const bundled = { './airline-logos/KA.png': '/assets/KA-abc.png' }
    expect(logoSrc(bundled, 'KA')).toBe('/assets/KA-abc.png')
    expect(logoSrc(bundled, 'ka')).toBe('/assets/KA-abc.png')
  })

  it('falls back to the image service when nothing is bundled for the code', () => {
    const bundled = { './airline-logos/KA.png': '/assets/KA-abc.png' }
    expect(logoSrc(bundled, 'BA')).toBe('https://images.kiwi.com/airlines/32/BA.png')
    expect(logoSrc({}, 'ba')).toBe('https://images.kiwi.com/airlines/32/BA.png')
  })
})

describe('badgeHue', () => {
  it('is stable, case-insensitive and within 0-359', () => {
    expect(badgeHue('KA')).toBe(badgeHue('ka'))
    expect(badgeHue('KA')).not.toBe(badgeHue('BA'))
    for (const code of ['KA', 'BA', 'AF', '4U', 'ZZ']) {
      expect(badgeHue(code)).toBeGreaterThanOrEqual(0)
      expect(badgeHue(code)).toBeLessThan(360)
    }
  })
})
