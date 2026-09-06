import { describe, expect, it } from 'vitest'
import {
  angularDifference,
  crabAngleDeg,
  crosswindComponent,
  headwindComponent,
  positionRelativeToRunway
} from './landing-maths'

describe('angularDifference', () => {
  it('is 0 for identical headings', () => {
    expect(angularDifference(30, 30)).toBe(0)
  })

  it('takes the short way around 0/360', () => {
    expect(angularDifference(10, 350)).toBe(20)
  })

  it('is 180 for reciprocal headings', () => {
    expect(angularDifference(0, 180)).toBe(180)
  })
})

describe('headwindComponent / crosswindComponent', () => {
  it('wind directly down the runway is a pure headwind with zero crosswind', () => {
    expect(headwindComponent(10, 90, 90)).toBeCloseTo(10, 6)
    expect(crosswindComponent(10, 90, 90)).toBeCloseTo(0, 6)
  })

  it('wind from behind is a pure tailwind (negative headwind), still zero crosswind', () => {
    expect(headwindComponent(10, 270, 90)).toBeCloseTo(-10, 6)
    expect(crosswindComponent(10, 270, 90)).toBeCloseTo(0, 6)
  })

  it('wind from the right of the runway heading is a pure crosswind, zero headwind', () => {
    expect(headwindComponent(10, 180, 90)).toBeCloseTo(0, 6)
    expect(crosswindComponent(10, 180, 90)).toBeCloseTo(10, 6)
  })

  it('wind from the left is a negative crosswind', () => {
    expect(crosswindComponent(10, 0, 90)).toBeCloseTo(-10, 6)
  })
})

describe('crabAngleDeg', () => {
  it('is 0 when the nose exactly matches the runway heading', () => {
    expect(crabAngleDeg(90, 90)).toBe(0)
  })

  it('is positive when the nose is right of the runway heading', () => {
    expect(crabAngleDeg(100, 90)).toBeCloseTo(10, 6)
  })

  it('is negative when the nose is left of the runway heading', () => {
    expect(crabAngleDeg(80, 90)).toBeCloseTo(-10, 6)
  })

  it('takes the short way around the 0/360 wrap', () => {
    expect(crabAngleDeg(5, 355)).toBeCloseTo(10, 6)
    expect(crabAngleDeg(355, 5)).toBeCloseTo(-10, 6)
  })

  it('is exactly 180 for a reciprocal heading', () => {
    expect(crabAngleDeg(180, 0)).toBeCloseTo(180, 6)
  })
})

describe('positionRelativeToRunway', () => {
  it('is zero/zero exactly at the threshold', () => {
    const result = positionRelativeToRunway(51.5, -0.5, 51.5, -0.5, 90)
    expect(result.distanceFromThresholdM).toBeCloseTo(0, 3)
    expect(result.centrelineOffsetM).toBeCloseTo(0, 3)
  })

  it('reads distance down a north-heading runway from a position north of the threshold', () => {
    const result = positionRelativeToRunway(0.001, 0, 0, 0, 0)
    expect(result.distanceFromThresholdM).toBeCloseTo(111.32, 0)
    expect(result.centrelineOffsetM).toBeCloseTo(0, 0)
  })

  it('reads a positive centreline offset to the right of a north-heading runway', () => {
    const result = positionRelativeToRunway(0, 0.0001, 0, 0, 0)
    expect(result.centrelineOffsetM).toBeGreaterThan(0)
    expect(result.distanceFromThresholdM).toBeCloseTo(0, 0)
  })

  it('reads a negative centreline offset to the left', () => {
    const result = positionRelativeToRunway(0, -0.0001, 0, 0, 0)
    expect(result.centrelineOffsetM).toBeLessThan(0)
  })
})
