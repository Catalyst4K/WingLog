import { describe, expect, it } from 'vitest'
import { followBand, zoomForBand } from './followZoom'

const FT = 0.3048
const air = (ft: number): { onGround: false; altitudeM: number; pressureAltitudeM: number } => ({
  onGround: false,
  altitudeM: ft * FT,
  pressureAltitudeM: ft * FT
})

describe('followBand / zoomForBand (Callum, 2026-10-02: 11, 10, 9 by altitude)', () => {
  it('picks the band from pressure altitude, with real YBBN-VHHH levels', () => {
    expect(zoomForBand(followBand({ onGround: true, altitudeM: 4, pressureAltitudeM: 4 }, null))).toBe(15)
    expect(zoomForBand(followBand(air(3_000), null))).toBe(11) // climb-out
    expect(zoomForBand(followBand(air(15_000), null))).toBe(10)
    expect(zoomForBand(followBand(air(38_000), null))).toBe(9) // initial cruise
    expect(zoomForBand(followBand(air(40_000), null))).toBe(9) // after the step climb
  })

  it('holds the band within 500 ft of its edge, so levelling off near it never flicks the zoom', () => {
    const low = followBand(air(9_000), null)
    expect(followBand(air(10_300), low)).toBe(low) // just through 10,000 ft: still band 0
    expect(followBand(air(10_600), low)).not.toBe(low) // clearly through: band 1
    const mid = followBand(air(12_000), null)
    expect(followBand(air(9_700), mid)).toBe(mid) // a dip just under 10,000 ft
    expect(followBand(air(9_400), mid)).toBe(low)
    const top = followBand(air(30_000), null)
    expect(followBand(air(24_700), top)).toBe(top)
    expect(followBand(air(24_400), top)).toBe(mid)
  })

  it('falls back to true altitude on older rows with no pressure altitude', () => {
    expect(zoomForBand(followBand({ onGround: false, altitudeM: 35_000 * FT, pressureAltitudeM: null }, null))).toBe(9)
  })

  it('goes straight to ground on touchdown, whatever the previous band', () => {
    expect(followBand({ onGround: true, altitudeM: 8, pressureAltitudeM: 8 }, 0)).toBe('ground')
  })
})
