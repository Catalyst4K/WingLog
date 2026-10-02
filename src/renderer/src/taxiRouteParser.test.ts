import { describe, expect, it } from 'vitest'
import { parseTaxiHoldShortRunway, parseTaxiHoldingPoint, parseTaxiRoute, parseTaxiStand } from './taxiRouteParser'

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

describe('a split arrival clearance, "taxi via …, hold short of runway …" (real, VHHH 2026-10-02)', () => {
  const LINE = 'Hongkong Shuttle 251, taxi via C7, Y, F, hold short of runway 07C.'

  it('reads the taxiways and the runway to hold short of', () => {
    expect(parseTaxiRoute(LINE)).toEqual(['C7', 'Y', 'F'])
    expect(parseTaxiHoldShortRunway(LINE)).toBe('07C')
  })

  it('has no holding point or stand of its own', () => {
    expect(parseTaxiHoldingPoint(LINE)).toBeNull()
    expect(parseTaxiStand(LINE)).toBeNull()
  })

  it('reads no hold-short runway from the other shapes', () => {
    expect(parseTaxiHoldShortRunway('Hongkong Shuttle 251, taxi to holding point A, runway 08, via D, B7, A.')).toBeNull()
    expect(parseTaxiHoldShortRunway('Hongkong Shuttle 251, holding short, runway 08.')).toBeNull()
  })
})

describe('parseTaxiHoldingPoint', () => {
  it('extracts the holding point from a real VHHH departure clearance (2026-09-30)', () => {
    expect(parseTaxiHoldingPoint('Hongkong Shuttle 250, taxi to holding point B10, runway 25C, via B8, B.')).toBe('B10')
  })

  it('returns null for an arrival (taxi-to-stand) clearance', () => {
    expect(parseTaxiHoldingPoint('Test 830, taxi to Stand 73 via D1, D, P3.')).toBeNull()
  })
})

describe('parseTaxiStand', () => {
  it("reads the stand from a real arrival clearance, and nothing from a departure one", () => {
    expect(parseTaxiStand('Cathay 168 Heavy, taxi to Stand N32 via J, H6, H, V, B.')).toBe('N32')
    expect(parseTaxiStand('Cathay 168 Heavy, taxi to holding point A9, runway 01R, via C9, B9.')).toBeNull()
  })
})
