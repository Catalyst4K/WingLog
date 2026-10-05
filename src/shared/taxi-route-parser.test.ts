import { describe, expect, it } from 'vitest'
import { parseTaxiHoldShortRunway } from './taxi-route-parser'

describe('parseTaxiHoldShortRunway', () => {
  it('reads the runway from the first half of a real split clearance (VHHH, 2026-10-02)', () => {
    expect(parseTaxiHoldShortRunway('Hongkong Shuttle 251, taxi via C7, Y, F, hold short of runway 07C.')).toBe('07C')
  })

  it("reads it past Heathrow's link taxiways, whose names contain a space (EGLL, flight 229, 2026-10-05)", () => {
    expect(parseTaxiHoldShortRunway('Koreanair 443 Heavy, taxi via E, LINK 36, F, A, R, hold short of runway 27L.')).toBe('27L')
  })

  it('reads nothing from other taxi clearances or a bare "holding short"', () => {
    // The real second half of the EGLL split clearance.
    expect(parseTaxiHoldShortRunway('Koreanair 443 Heavy, via N5E cross runway 27L, taxi to Stand 411 via A, R, N5W, S5W, W, LINK 44, T.')).toBeNull()
    expect(parseTaxiHoldShortRunway('Hongkong Shuttle 251, taxi to holding point A, runway 08, via D, B7, A.')).toBeNull()
    expect(parseTaxiHoldShortRunway('Hongkong Shuttle 251, holding short, runway 08.')).toBeNull()
    // An ordinary word after a taxiway isn't a taxiway name.
    expect(parseTaxiHoldShortRunway('Test 230, taxi via E, F then, hold short of runway 27L.')).toBeNull()
  })
})
