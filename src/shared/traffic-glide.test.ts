import { describe, expect, it } from 'vitest'
import { greatCircleM } from './geo'
import { glidePosition, MAX_GLIDE_S } from './traffic-glide'

const base = { latitude: 51, longitude: -1, headingDeg: 90, groundSpeedMs: 100, onGround: false, ageS: 0 }

describe('glidePosition', () => {
  it('stays where it was reported at the moment the payload arrives with age 0', () => {
    expect(glidePosition(base, 0)).toEqual({ lat: 51, lon: -1 })
  })

  it('moves ground speed times the time along the heading: 100 m/s for 10 s east is 1 km', () => {
    const at = glidePosition(base, 10)
    expect(greatCircleM({ lat: 51, lon: -1 }, at)).toBeCloseTo(1000, 0)
    expect(at.lon).toBeGreaterThan(-1)
    expect(at.lat).toBeCloseTo(51, 3)
  })

  it('moves north on heading 0 and west on heading 270', () => {
    expect(glidePosition({ ...base, headingDeg: 0 }, 10).lat).toBeGreaterThan(51)
    expect(glidePosition({ ...base, headingDeg: 270 }, 10).lon).toBeLessThan(-1)
  })

  it('counts the age at the feed as time already flown', () => {
    const fromAge = glidePosition({ ...base, ageS: 4 }, 6)
    const fromScreen = glidePosition(base, 10)
    expect(fromAge.lon).toBeCloseTo(fromScreen.lon, 9)
  })

  it('stops after the cap, whatever the time', () => {
    const atCap = glidePosition(base, MAX_GLIDE_S)
    const later = glidePosition(base, 500)
    expect(later).toEqual(atCap)
    expect(greatCircleM({ lat: 51, lon: -1 }, later)).toBeCloseTo(100 * MAX_GLIDE_S, 0)
  })

  it('caps an old report from the start: the age counts towards the cap', () => {
    expect(glidePosition({ ...base, ageS: 100 }, 0)).toEqual(glidePosition(base, MAX_GLIDE_S))
  })

  it('does not glide on the ground', () => {
    expect(glidePosition({ ...base, onGround: true, ageS: 5 }, 20)).toEqual({ lat: 51, lon: -1 })
  })

  it('does not move backwards for a clock that stepped back', () => {
    expect(glidePosition(base, -5)).toEqual({ lat: 51, lon: -1 })
  })

  it('does not move an aircraft with no ground speed', () => {
    expect(glidePosition({ ...base, groundSpeedMs: 0 }, 20).lon).toBeCloseTo(-1, 9)
  })
})
