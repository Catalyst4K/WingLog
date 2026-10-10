import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { AirlineLogo } from './AirlineLogo'
import { logoSrc } from './airline-logo-src'

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

  it('hides itself on a failed image load rather than showing a broken icon', () => {
    const { container } = render(<AirlineLogo iata="ZZ" />)
    const img = container.querySelector('img')!
    fireEvent.error(img)
    expect(img).toHaveStyle({ display: 'none' })
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
