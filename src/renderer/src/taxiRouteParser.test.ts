import { describe, expect, it } from 'vitest'
import { parseTaxiRoute } from './taxiRouteParser'

describe('parseTaxiRoute', () => {
  it('parses a real departure taxi clearance', () => {
    expect(parseTaxiRoute('Test 830, taxi to holding point T1, runway 20C, via P7, Q, T1.')).toEqual(['P7', 'Q', 'T1'])
  })

  it('parses a real departure taxi clearance with a named link taxiway', () => {
    expect(parseTaxiRoute('Test 230, taxi to holding point A1, runway 27R, via D, B, LINK.')).toEqual(['D', 'B', 'LINK'])
  })

  it('parses a real arrival (taxi-to-stand) clearance', () => {
    expect(parseTaxiRoute('Test 830, taxi to Stand 73 via D1, D, P3, L02, W1, T4, W6, L08.')).toEqual([
      'D1',
      'D',
      'P3',
      'L02',
      'W1',
      'T4',
      'W6',
      'L08'
    ])
  })

  it('is case-insensitive', () => {
    expect(parseTaxiRoute('test 830, TAXI TO STAND 73 VIA D1, D.')).toEqual(['D1', 'D'])
  })

  it('returns null for "ready to taxi to the active" (no route yet)', () => {
    expect(parseTaxiRoute('Test 830, ready to taxi to the active.')).toBeNull()
  })

  it('returns null for an unrelated ATC line', () => {
    expect(parseTaxiRoute('Test 830, contact Test Radar 134.7.')).toBeNull()
  })

  it('returns null for an approach clearance (also contains "via", must not collide)', () => {
    expect(parseTaxiRoute('Test 830, cleared direct PD201, cross PD201 at or above 900m, cleared ILS-Z approach runway 17R.')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseTaxiRoute('')).toBeNull()
  })
})
