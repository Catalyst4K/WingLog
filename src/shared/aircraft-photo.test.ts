import { describe, expect, it } from 'vitest'
import {
  CUSTOM_PHOTO_MAX_CHARS,
  CUSTOM_PHOTO_PREFIX,
  PHOTO_URL_MAX_CHARS,
  isCustomPhoto,
  isPhotoUrl
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
