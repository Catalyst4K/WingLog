import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AircraftPhotoSources } from '@shared/aircraft-photo'
import type { WingLogApi } from '@shared/ipc'
import i18n from './i18n'
import { AircraftPhoto } from './AircraftPhoto'

const THUMB = 'https://airport-data.com/images/aircraft/thumbnails/001/685/001685661.jpg'
const FULL = 'https://image.airport-data.com/aircraft/001685661.jpg'
const OWN = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
const SPOTTERS = {
  photoUrl: 'https://t.plnspttrs.net/00978/1947470_54b1bd86b7_280.jpg',
  photographer: 'John Robert Murdoch',
  pageUrl: 'https://www.planespotters.net/photo/1947470/g-eztk-easyjet-airbus-a320-214?utm_source=api'
}

const NONE: AircraftPhotoSources = {
  customPhoto: null,
  planespotters: null,
  photoUrl: null,
  thumbnailUrl: null
}

describe('AircraftPhoto', () => {
  const aircraftOpenPhotoPage = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    aircraftOpenPhotoPage.mockClear()
    window.winglog = { aircraftOpenPhotoPage } as unknown as WingLogApi
  })

  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the attribution caption in the active i18next language, not a hardcoded English string', async () => {
    await i18n.changeLanguage('de')
    const { getByText } = render(<AircraftPhoto sources={{ ...NONE, photoUrl: FULL }} />)
    expect(getByText('Foto via airport-data.com')).toBeInTheDocument()
  })

  it('renders nothing when there is no photo at all', () => {
    const { container } = render(<AircraftPhoto sources={NONE} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the full-size photo with its attribution caption', () => {
    const { container, getByText } = render(
      <AircraftPhoto sources={{ ...NONE, photoUrl: FULL, thumbnailUrl: THUMB }} />
    )
    expect(container.querySelector('img')).toHaveAttribute('src', FULL)
    expect(getByText('Photo via airport-data.com')).toBeInTheDocument()
  })

  it('shows the thumbnail when the aircraft has only that, as it did before the full-size link was stored', () => {
    const { container } = render(<AircraftPhoto sources={{ ...NONE, thumbnailUrl: THUMB }} />)
    expect(container.querySelector('img')).toHaveAttribute('src', THUMB)
  })

  it('shows the pilot’s own picture first, with no credit', () => {
    const { container, queryByText } = render(
      <AircraftPhoto
        sources={{ customPhoto: OWN, planespotters: SPOTTERS, photoUrl: FULL, thumbnailUrl: THUMB }}
      />
    )
    expect(container.querySelector('img')).toHaveAttribute('src', OWN)
    expect(queryByText('Photo via airport-data.com')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
  })

  describe('a Planespotters photo', () => {
    const sources: AircraftPhotoSources = {
      customPhoto: null,
      planespotters: SPOTTERS,
      photoUrl: FULL,
      thumbnailUrl: THUMB
    }

    it('is shown ahead of the airport-data ones, credited to the photographer', () => {
      const { container } = render(<AircraftPhoto sources={sources} />)
      expect(container.querySelector('img')).toHaveAttribute('src', SPOTTERS.photoUrl)
      expect(screen.getByText(/Photo: John Robert Murdoch/)).toBeInTheDocument()
      expect(screen.queryByText('Photo via airport-data.com')).toBeNull()
    })

    it('links both the photo and the credit to the photo’s page, as plain anchors', () => {
      const { container } = render(<AircraftPhoto sources={sources} />)
      const anchors = Array.from(container.querySelectorAll('a'))
      expect(anchors).toHaveLength(2)
      for (const anchor of anchors) {
        expect(anchor).toHaveAttribute('href', SPOTTERS.pageUrl)
        expect(anchor).not.toHaveAttribute('rel')
      }
      expect(anchors[0]).toContainElement(container.querySelector('img'))
      expect(anchors[1]).toHaveTextContent('Planespotters.net')
    })

    it('opens the page through the app, not in this window', () => {
      const { container } = render(<AircraftPhoto sources={sources} />)
      const notPrevented = fireEvent.click(container.querySelector('img')!)
      expect(notPrevented).toBe(false)
      expect(aircraftOpenPhotoPage).toHaveBeenCalledWith(SPOTTERS.pageUrl)
      fireEvent.click(screen.getByText('Planespotters.net'))
      expect(aircraftOpenPhotoPage).toHaveBeenCalledTimes(2)
    })

    it('credits the photographer in the active language', async () => {
      await i18n.changeLanguage('de')
      render(<AircraftPhoto sources={sources} />)
      expect(screen.getByText(/Foto: John Robert Murdoch/)).toBeInTheDocument()
    })

    it('gives way to the airport-data photo, and its credit, if it fails to load', () => {
      const { container } = render(<AircraftPhoto sources={sources} />)
      fireEvent.error(container.querySelector('img')!)
      expect(container.querySelector('img')).toHaveAttribute('src', FULL)
      expect(screen.getByText('Photo via airport-data.com')).toBeInTheDocument()
      expect(container.querySelector('a')).toBeNull()
    })

    it('is also credited and linked in the small preview', () => {
      const { container } = render(<AircraftPhoto sources={sources} variant="preview" />)
      expect(container.querySelector('img')).toHaveClass('max-h-40')
      expect(container.querySelectorAll('a')).toHaveLength(2)
    })
  })

  it('falls back from the pilot’s picture to the full-size photo to the thumbnail as each fails to load', () => {
    const { container, getByText } = render(
      <AircraftPhoto sources={{ ...NONE, customPhoto: OWN, photoUrl: FULL, thumbnailUrl: THUMB }} />
    )
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toHaveAttribute('src', FULL)
    expect(getByText('Photo via airport-data.com')).toBeInTheDocument()
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toHaveAttribute('src', THUMB)
  })

  it('hides the figure once every source has failed to load', () => {
    const { container } = render(<AircraftPhoto sources={{ ...NONE, photoUrl: FULL, thumbnailUrl: THUMB }} />)
    fireEvent.error(container.querySelector('img')!)
    fireEvent.error(container.querySelector('img')!)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a different aircraft’s photo again even after a previous one failed', () => {
    const { container, rerender } = render(<AircraftPhoto sources={{ ...NONE, photoUrl: FULL }} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container).toBeEmptyDOMElement()

    const otherUrl = 'https://image.airport-data.com/aircraft/999999999.jpg'
    rerender(<AircraftPhoto sources={{ ...NONE, photoUrl: otherUrl }} />)
    expect(container.querySelector('img')).toHaveAttribute('src', otherUrl)
  })

  describe('the large photo’s shape', () => {
    /** The box's shape as set on the image: the browser writes aspect-ratio as "1.5 / 1". */
    function ratioOf(img: HTMLImageElement): number {
      const [width, height = '1'] = img.style.aspectRatio.split('/')
      return Number(width) / Number(height)
    }

    /** Loads the shown image as the browser would, with the picture's pixel size. */
    function loadWithSize(img: HTMLImageElement, width: number, height: number): void {
      Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true })
      Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true })
      fireEvent.load(img)
    }

    it('is the full width of the card and never cropped, 3:2 until the picture says otherwise', () => {
      const { container } = render(<AircraftPhoto sources={{ ...NONE, photoUrl: FULL }} alt="G-EZTK A320" />)
      const img = container.querySelector('img')!
      expect(img).toHaveClass('w-full', 'object-contain')
      expect(img).not.toHaveClass('object-cover')
      expect(img).toHaveAttribute('alt', 'G-EZTK A320')
      expect(ratioOf(img)).toBeCloseTo(3 / 2, 5)
    })

    it('takes the picture’s own shape once loaded, so a 16:9 photo fills the box with no bands', () => {
      const { container } = render(<AircraftPhoto sources={{ ...NONE, photoUrl: FULL }} />)
      const img = container.querySelector('img')!
      loadWithSize(img, 498, 280)
      expect(ratioOf(img)).toBeCloseTo(498 / 280, 5)
    })

    it('limits how tall or how flat the box gets, still showing the whole picture', () => {
      const { container } = render(<AircraftPhoto sources={{ ...NONE, photoUrl: FULL }} />)
      const img = container.querySelector('img')!
      loadWithSize(img, 1000, 1500)
      expect(ratioOf(img)).toBeCloseTo(6 / 5, 5)
      expect(img).toHaveClass('object-contain')
      loadWithSize(img, 4000, 500)
      expect(ratioOf(img)).toBeCloseTo(3, 5)
    })

    it('does not keep the last picture’s shape when the next source loads', () => {
      const { container } = render(
        <AircraftPhoto sources={{ ...NONE, photoUrl: FULL, thumbnailUrl: THUMB }} />
      )
      loadWithSize(container.querySelector('img')!, 498, 280)
      fireEvent.error(container.querySelector('img')!)
      expect(container.querySelector('img')).toHaveAttribute('src', THUMB)
      expect(ratioOf(container.querySelector('img')!)).toBeCloseTo(3 / 2, 5)
    })

    it('ignores a load event that reports no size', () => {
      const { container } = render(<AircraftPhoto sources={{ ...NONE, photoUrl: FULL }} />)
      const img = container.querySelector('img')!
      loadWithSize(img, 0, 0)
      expect(ratioOf(img)).toBeCloseTo(3 / 2, 5)
    })
  })

  it('is small in the form', () => {
    const { container } = render(<AircraftPhoto sources={{ ...NONE, photoUrl: FULL }} variant="preview" />)
    expect(container.querySelector('img')).toHaveClass('max-h-40')
  })
})
