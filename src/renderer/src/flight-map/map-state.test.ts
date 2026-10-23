import { describe, expect, it } from 'vitest'
import { isMapVisible } from './map-state'

describe('isMapVisible', () => {
  const following = { live: true, framed: false, followEnabled: true, trackLoading: false, hasAircraft: true }

  it('hides Track’s map while it is about to frame an aircraft it follows', () => {
    expect(isMapVisible(following)).toBe(false)
  })

  it('shows it once framed', () => {
    expect(isMapVisible({ ...following, framed: true })).toBe(true)
  })

  it('always shows the Logbook’s static map', () => {
    expect(isMapVisible({ ...following, live: false })).toBe(true)
  })

  it('shows it straight away with follow off', () => {
    expect(isMapVisible({ ...following, followEnabled: false })).toBe(true)
  })

  it('shows it with no flight to follow, but not while the track is still loading', () => {
    expect(isMapVisible({ ...following, hasAircraft: false })).toBe(true)
    expect(isMapVisible({ ...following, hasAircraft: false, trackLoading: true })).toBe(false)
  })
})
