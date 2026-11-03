import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import i18n from './i18n'
import { AircraftPhoto } from './AircraftPhoto'

const THUMB = 'https://airport-data.com/images/aircraft/thumbnails/001/685/001685661.jpg'
const FULL = 'https://image.airport-data.com/aircraft/001685661.jpg'
const OWN = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

const NONE = { customPhoto: null, photoUrl: null, thumbnailUrl: null }

describe('AircraftPhoto', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the attribution caption in the active i18next language, not a hardcoded English string', async () => {
    await i18n.changeLanguage('de')
    const { getByText } = render(<AircraftPhoto {...NONE} photoUrl={FULL} />)
    expect(getByText('Foto via airport-data.com')).toBeInTheDocument()
  })

  it('renders nothing when there is no photo at all', () => {
    const { container } = render(<AircraftPhoto {...NONE} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the full-size photo with its attribution caption', () => {
    const { container, getByText } = render(<AircraftPhoto {...NONE} photoUrl={FULL} thumbnailUrl={THUMB} />)
    expect(container.querySelector('img')).toHaveAttribute('src', FULL)
    expect(getByText('Photo via airport-data.com')).toBeInTheDocument()
  })

  it('shows the thumbnail when the aircraft has only that, as it did before the full-size link was stored', () => {
    const { container } = render(<AircraftPhoto {...NONE} thumbnailUrl={THUMB} />)
    expect(container.querySelector('img')).toHaveAttribute('src', THUMB)
  })

  it('shows the pilot’s own picture first, with no credit to airport-data.com', () => {
    const { container, queryByText } = render(
      <AircraftPhoto customPhoto={OWN} photoUrl={FULL} thumbnailUrl={THUMB} />
    )
    expect(container.querySelector('img')).toHaveAttribute('src', OWN)
    expect(queryByText('Photo via airport-data.com')).toBeNull()
  })

  it('falls back from the pilot’s picture to the full-size photo to the thumbnail as each fails to load', () => {
    const { container, getByText } = render(
      <AircraftPhoto customPhoto={OWN} photoUrl={FULL} thumbnailUrl={THUMB} />
    )
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toHaveAttribute('src', FULL)
    expect(getByText('Photo via airport-data.com')).toBeInTheDocument()
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toHaveAttribute('src', THUMB)
  })

  it('hides the figure once every source has failed to load', () => {
    const { container } = render(<AircraftPhoto {...NONE} photoUrl={FULL} thumbnailUrl={THUMB} />)
    fireEvent.error(container.querySelector('img')!)
    fireEvent.error(container.querySelector('img')!)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a different aircraft’s photo again even after a previous one failed', () => {
    const { container, rerender } = render(<AircraftPhoto {...NONE} photoUrl={FULL} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container).toBeEmptyDOMElement()

    const otherUrl = 'https://image.airport-data.com/aircraft/999999999.jpg'
    rerender(<AircraftPhoto {...NONE} photoUrl={otherUrl} />)
    expect(container.querySelector('img')).toHaveAttribute('src', otherUrl)
  })

  it('is large and edge to edge on the detail page, and small in the form', () => {
    const { container, rerender } = render(<AircraftPhoto {...NONE} photoUrl={FULL} alt="G-EZTK A320" />)
    expect(container.querySelector('img')).toHaveClass('aspect-[3/2]', 'w-full')
    expect(container.querySelector('img')).toHaveAttribute('alt', 'G-EZTK A320')
    rerender(<AircraftPhoto {...NONE} photoUrl={FULL} variant="preview" />)
    expect(container.querySelector('img')).toHaveClass('max-h-40')
  })
})
