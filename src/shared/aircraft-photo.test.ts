import { describe, expect, it } from 'vitest'
import {
  CUSTOM_PHOTO_MAX_CHARS,
  CUSTOM_PHOTO_PREFIX,
  PHOTOGRAPHER_MAX_CHARS,
  PHOTO_BOX_DEFAULT_RATIO,
  PHOTO_BOX_MAX_RATIO,
  PHOTO_BOX_MIN_RATIO,
  PHOTO_URL_MAX_CHARS,
  isCustomPhoto,
  isPhotographer,
  isPhotoUrl,
  isPlanespottersImage,
  isPlanespottersPage,
  photoBoxRatio,
  photoSourcesOf
} from './aircraft-photo'

describe('isCustomPhoto', () => {
  it('accepts a base64 JPEG data URL', () => {
    expect(isCustomPhoto('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==')).toBe(true)
  })

  it.each([
    ['a PNG data URL', 'data:image/png;base64,iVBORw0KGgo='],
    ['an SVG data URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['a data URL with nothing after the prefix', CUSTOM_PHOTO_PREFIX],
    ['characters base64 does not use', CUSTOM_PHOTO_PREFIX + 'abc def'],
    ['too much padding', CUSTOM_PHOTO_PREFIX + 'abc==='],
    ['a web link', 'https://example.com/a.jpg'],
    ['an empty string', '']
  ])('rejects %s', (_label, value) => {
    expect(isCustomPhoto(value)).toBe(false)
  })

  it('accepts one exactly at the limit and rejects one over it', () => {
    const atLimit = CUSTOM_PHOTO_PREFIX + 'A'.repeat(CUSTOM_PHOTO_MAX_CHARS - CUSTOM_PHOTO_PREFIX.length)
    expect(atLimit.length).toBe(CUSTOM_PHOTO_MAX_CHARS)
    expect(isCustomPhoto(atLimit)).toBe(true)
    expect(isCustomPhoto(atLimit + 'A')).toBe(false)
  })
})

describe('isPhotoUrl', () => {
  it('accepts an https link', () => {
    expect(isPhotoUrl('https://image.airport-data.com/aircraft/001685661.jpg')).toBe(true)
  })

  it.each([
    ['http', 'http://image.airport-data.com/aircraft/1.jpg'],
    ['javascript:', 'javascript:alert(1)'],
    ['file:', 'file:///C:/secret.jpg'],
    ['data:', 'data:image/jpeg;base64,AAAA'],
    ['text that is not a link', 'airport-data.com/1.jpg'],
    ['an empty string', '']
  ])('rejects %s', (_label, value) => {
    expect(isPhotoUrl(value)).toBe(false)
  })

  it('rejects a link over the length limit', () => {
    expect(isPhotoUrl('https://a.example/' + 'x'.repeat(PHOTO_URL_MAX_CHARS))).toBe(false)
  })
})

describe('isPlanespottersImage and isPlanespottersPage', () => {
  it('accept an https link on the right Planespotters host', () => {
    expect(isPlanespottersImage('https://t.plnspttrs.net/00978/1947470_54b1bd86b7_280.jpg')).toBe(true)
    expect(isPlanespottersPage('https://www.planespotters.net/photo/1947470/g-eztk?utm_source=api')).toBe(
      true
    )
  })

  it.each([
    ['the other Planespotters host', 'https://www.planespotters.net/photo/1', isPlanespottersImage],
    ['the other Planespotters host', 'https://t.plnspttrs.net/a.jpg', isPlanespottersPage],
    ['a look-alike host', 'https://t.plnspttrs.net.evil.example/a.jpg', isPlanespottersImage],
    ['a look-alike host', 'https://www.planespotters.net.evil.example/photo/1', isPlanespottersPage],
    ['a host that only ends the same', 'https://notwww.planespotters.net/photo/1', isPlanespottersPage],
    ['http', 'http://www.planespotters.net/photo/1', isPlanespottersPage],
    [
      'a link with credentials for another host',
      'https://www.planespotters.net@evil.example/photo/1',
      isPlanespottersPage
    ]
  ])('refuse %s', (_label, value, check) => {
    expect(check(value)).toBe(false)
  })
})

describe('isPhotographer', () => {
  it.each(['John Robert Murdoch', 'Björn Wylezich', '李雷', 'Sebastian K'])('accepts %s', (name) => {
    expect(isPhotographer(name)).toBe(true)
  })

  it.each([
    ['nothing', ''],
    ['only spaces', '   '],
    ['a control character', 'Eve\u0007'],
    ['a newline', 'Eve\nLog'],
    ['a delete character', 'Eve\u007f'],
    ['a name that is too long', 'x'.repeat(PHOTOGRAPHER_MAX_CHARS + 1)]
  ])('refuses %s', (_label, name) => {
    expect(isPhotographer(name)).toBe(false)
  })

  it('accepts one exactly at the limit', () => {
    expect(isPhotographer('x'.repeat(PHOTOGRAPHER_MAX_CHARS))).toBe(true)
  })
})

describe('photoSourcesOf', () => {
  const none = {
    customPhoto: null,
    planespottersPhotoUrl: null,
    planespottersPhotographer: null,
    planespottersPageUrl: null,
    photoUrl: null,
    photoThumbnailUrl: null
  }

  it('gathers an aircraft’s photo fields, with Planespotters’ three as one photo', () => {
    expect(
      photoSourcesOf({
        ...none,
        customPhoto: 'data:image/jpeg;base64,AAAA',
        planespottersPhotoUrl: 'https://t.plnspttrs.net/a_280.jpg',
        planespottersPhotographer: 'John Robert Murdoch',
        planespottersPageUrl: 'https://www.planespotters.net/photo/1',
        photoUrl: 'https://image.airport-data.com/f.jpg',
        photoThumbnailUrl: 'https://airport-data.com/t.jpg'
      })
    ).toEqual({
      customPhoto: 'data:image/jpeg;base64,AAAA',
      planespotters: {
        photoUrl: 'https://t.plnspttrs.net/a_280.jpg',
        photographer: 'John Robert Murdoch',
        pageUrl: 'https://www.planespotters.net/photo/1'
      },
      photoUrl: 'https://image.airport-data.com/f.jpg',
      thumbnailUrl: 'https://airport-data.com/t.jpg'
    })
  })

  it.each(['planespottersPhotoUrl', 'planespottersPhotographer', 'planespottersPageUrl'] as const)(
    'has no Planespotters photo when %s is missing, since its terms need all three',
    (missing) => {
      const all = {
        ...none,
        planespottersPhotoUrl: 'https://t.plnspttrs.net/a_280.jpg',
        planespottersPhotographer: 'John Robert Murdoch',
        planespottersPageUrl: 'https://www.planespotters.net/photo/1'
      }
      expect(photoSourcesOf({ ...all, [missing]: null }).planespotters).toBeNull()
    }
  )
})

describe('photoBoxRatio', () => {
  it.each([
    ['a camera’s 3:2', 3 / 2],
    ['B-LJE’s Planespotters photo, 498 × 280', 498 / 280],
    ['16:9', 16 / 9],
    ['4:3', 4 / 3],
    ['airport-data’s 1621 × 1000', 1621 / 1000]
  ])('gives %s the picture’s own shape, so nothing is cropped', (_label, ratio) => {
    expect(photoBoxRatio(ratio)).toBe(ratio)
  })

  it('stops a very tall picture making the card taller than 6:5', () => {
    expect(photoBoxRatio(2 / 3)).toBe(PHOTO_BOX_MIN_RATIO)
    expect(photoBoxRatio(1)).toBe(PHOTO_BOX_MIN_RATIO)
  })

  it('stops a very wide picture making the card flatter than 3:1', () => {
    expect(photoBoxRatio(5)).toBe(PHOTO_BOX_MAX_RATIO)
  })

  it('keeps the box shape before the picture has loaded inside its own limits', () => {
    expect(photoBoxRatio(PHOTO_BOX_DEFAULT_RATIO)).toBe(PHOTO_BOX_DEFAULT_RATIO)
  })

  it('accepts exactly the limits', () => {
    expect(photoBoxRatio(PHOTO_BOX_MIN_RATIO)).toBe(PHOTO_BOX_MIN_RATIO)
    expect(photoBoxRatio(PHOTO_BOX_MAX_RATIO)).toBe(PHOTO_BOX_MAX_RATIO)
  })
})
