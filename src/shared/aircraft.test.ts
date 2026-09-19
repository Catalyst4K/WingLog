import { describe, expect, it } from 'vitest'
import { isRetired } from './aircraft'

describe('isRetired', () => {
  it('is false for an active aircraft', () => {
    expect(isRetired({ replacedByAircraftId: null, retiredAt: null })).toBe(false)
  })

  it('is true once replaced, even with no retiredAt (every aircraft replaced before plain Retire existed)', () => {
    expect(isRetired({ replacedByAircraftId: 7, retiredAt: null })).toBe(true)
  })

  it('is true once plainly retired', () => {
    expect(isRetired({ replacedByAircraftId: null, retiredAt: '2026-09-18T12:00:00.000Z' })).toBe(true)
  })
})
