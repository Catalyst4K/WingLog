import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import i18n from './i18n'
import { AircraftPhoto } from './AircraftPhoto'

const URL = 'https://airport-data.com/images/aircraft/thumbnails/001/685/001685661.jpg'

describe('AircraftPhoto', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the attribution caption in the active i18next language, not a hardcoded English string', async () => {
    await i18n.changeLanguage('de')
    const { getByText } = render(<AircraftPhoto thumbnailUrl={URL} />)
    expect(getByText('Foto via airport-data.com')).toBeInTheDocument()
  })

  it('renders nothing when there is no thumbnail URL', () => {
    const { container } = render(<AircraftPhoto thumbnailUrl={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the photo with its attribution caption', () => {
    const { container, getByText } = render(<AircraftPhoto thumbnailUrl={URL} />)
    expect(container.querySelector('img')).toHaveAttribute('src', URL)
    expect(getByText('Photo via airport-data.com')).toBeInTheDocument()
  })

  it('hides the figure after the image fails to load', () => {
    const { container } = render(<AircraftPhoto thumbnailUrl={URL} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a different aircraft’s photo again even after a previous one failed', () => {
    const { container, rerender } = render(<AircraftPhoto thumbnailUrl={URL} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container).toBeEmptyDOMElement()

    const otherUrl = 'https://airport-data.com/images/aircraft/thumbnails/999/999/999999999.jpg'
    rerender(<AircraftPhoto thumbnailUrl={otherUrl} />)
    expect(container.querySelector('img')).toHaveAttribute('src', otherUrl)
  })
})
