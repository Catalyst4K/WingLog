import { describe, expect, it } from 'vitest'
import type { NavdataStand } from './ipc'
import { findStand, nearestStand } from './stands'

// Real VHHH stands from the sim (TAXI_PARKING spike, 2026-10-02), and where the real
// YBBN-VHHH flight actually stopped at N32.
const N32: NavdataStand = { name: 'N32', number: 32, suffix: 0, headingDeg: 161, lat: 22.31414534384843, lon: 113.92862486374908 }
const N32_TWIN: NavdataStand = { name: 'N32', number: 32, suffix: 29, headingDeg: 161, lat: 22.314096641829128, lon: 113.92851484995053 }
const N30: NavdataStand = { name: 'N30', number: 30, suffix: 0, headingDeg: 160, lat: 22.31435084404371, lon: 113.92926930427937 }
const STANDS = [N30, N32_TWIN, N32]
const STOPPED_AT_N32 = { lat: 22.31404, lon: 113.92867 }

describe('nearestStand', () => {
  it('finds the stand the real flight stopped at (13 m from its point)', () => {
    expect(nearestStand(STANDS, STOPPED_AT_N32)).toBe(N32)
  })

  it('finds nothing when the aircraft stopped away from every stand', () => {
    expect(nearestStand(STANDS, { lat: 22.3155, lon: 113.9235 })).toBeNull()
    expect(nearestStand([], STOPPED_AT_N32)).toBeNull()
  })
})

describe('findStand', () => {
  it("matches ATC's plain name to the entry without a suffix, whatever the case", () => {
    expect(findStand(STANDS, 'N32')).toBe(N32)
    expect(findStand(STANDS, 'n32')).toBe(N32)
  })

  it('falls back to a twin when only twins exist, and finds nothing for an unknown stand', () => {
    expect(findStand([N32_TWIN], 'N32')).toBe(N32_TWIN)
    expect(findStand(STANDS, 'N99')).toBeNull()
  })
})
