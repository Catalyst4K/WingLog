import { describe, expect, it } from 'vitest'
import { parseAircraftInput } from './aircraft-validation'

describe('parseAircraftInput', () => {
  it('accepts the minimum required fields', () => {
    const result = parseAircraftInput({ registration: ' G-ABCD ', icaoType: 'A320' })
    expect(result).toEqual({ data: { registration: 'G-ABCD', icaoType: 'A320' } })
  })

  it('rejects a non-object', () => {
    expect(parseAircraftInput(null)).toEqual({ error: 'Expected an object' })
    expect(parseAircraftInput('G-ABCD')).toEqual({ error: 'Expected an object' })
  })

  it.each(['registration', 'icaoType'])('rejects a missing required field "%s"', (field) => {
    const input: Record<string, string> = { registration: 'G-ABCD', icaoType: 'A320' }
    delete input[field]
    expect(parseAircraftInput(input)).toEqual({ error: `"${field}" is required` })
  })

  it('rejects a blank required field', () => {
    expect(parseAircraftInput({ registration: '  ', icaoType: 'A320' })).toEqual({
      error: '"registration" is required'
    })
  })

  it('carries through valid optional fields', () => {
    const result = parseAircraftInput({
      registration: 'G-ABCD',
      icaoType: 'A320',
      operator: 'Test Air',
      simbriefAirframeId: '123456_1582090020',
      currentIcao: 'EGLL'
    })
    expect(result).toEqual({
      data: {
        registration: 'G-ABCD',
        icaoType: 'A320',
        operator: 'Test Air',
        simbriefAirframeId: '123456_1582090020',
        currentIcao: 'EGLL'
      }
    })
  })

  it('rejects a non-string optional field', () => {
    const result = parseAircraftInput({ registration: 'G-ABCD', icaoType: 'A320', operator: 42 })
    expect(result).toEqual({ error: '"operator" must be a string' })
  })

  // Real bug, found live (docs/plans/simbrief-airframe-picker.md): a field the caller
  // explicitly blanks must come back as `null`, not be dropped from `data` entirely — an
  // update's `.set()` only touches columns actually present in its payload, so a dropped
  // field silently leaves the row's existing value untouched instead of clearing it.
  it('clears an explicitly blank optional field to null, rather than omitting it', () => {
    const result = parseAircraftInput({
      registration: 'G-ABCD',
      icaoType: 'A320',
      simbriefAirframeId: '',
      operatorIata: null
    })
    expect(result).toEqual({
      data: {
        registration: 'G-ABCD',
        icaoType: 'A320',
        simbriefAirframeId: null,
        operatorIata: null
      }
    })
  })

  describe('the photo fields', () => {
    const base = { registration: 'G-ABCD', icaoType: 'A320' }
    const OWN = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

    it('carries a looked-up photo link, its full-size link and the pilot’s own picture', () => {
      const result = parseAircraftInput({
        ...base,
        photoThumbnailUrl: 'https://airport-data.com/images/aircraft/thumbnails/001/685/001685661.jpg',
        photoUrl: 'https://image.airport-data.com/aircraft/001685661.jpg',
        customPhoto: OWN
      })
      expect(result).toEqual({
        data: {
          ...base,
          photoThumbnailUrl: 'https://airport-data.com/images/aircraft/thumbnails/001/685/001685661.jpg',
          photoUrl: 'https://image.airport-data.com/aircraft/001685661.jpg',
          customPhoto: OWN
        }
      })
    })

    it('clears the pilot’s own picture when it is sent as null', () => {
      expect(parseAircraftInput({ ...base, customPhoto: null })).toEqual({
        data: { ...base, customPhoto: null }
      })
    })

    it.each([
      ['a link that is not https', 'photoUrl', 'http://image.airport-data.com/aircraft/1.jpg'],
      ['a script link', 'photoThumbnailUrl', 'javascript:alert(1)'],
      ['text that is not a link', 'photoUrl', 'not a url'],
      ['a file link', 'photoUrl', 'file:///C:/Users/pilot/secret.jpg'],
      ['a picture that is not a JPEG', 'customPhoto', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
      ['a data URL that is not base64', 'customPhoto', 'data:image/jpeg;base64,not base64!'],
      ['a plain link in place of a picture', 'customPhoto', 'https://example.com/me.jpg'],
      ['a picture over the size limit', 'customPhoto', 'data:image/jpeg;base64,' + 'A'.repeat(1_500_000)]
    ])('rejects %s', (_label, field, value) => {
      expect(parseAircraftInput({ ...base, [field]: value })).toEqual({
        error: `"${field}" is not a picture or link WingLog can keep`
      })
    })
  })

  it('still omits a field genuinely absent from the input, distinct from an explicit blank', () => {
    const result = parseAircraftInput({ registration: 'G-ABCD', icaoType: 'A320' })
    expect(result).toEqual({ data: { registration: 'G-ABCD', icaoType: 'A320' } })
    if ('data' in result) {
      expect('simbriefAirframeId' in result.data).toBe(false)
    }
  })
})
