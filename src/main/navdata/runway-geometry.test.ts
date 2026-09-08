import { describe, expect, it } from 'vitest'
import type { ParsedRunway } from '../sim/facility-fields'
import { runwayEndsFromCentre } from './runway-geometry'

const METERS_PER_DEG_LAT = 111_320

function metersPerDegLon(atLatDeg: number): number {
  return METERS_PER_DEG_LAT * Math.cos((atLatDeg * Math.PI) / 180)
}

describe('runwayEndsFromCentre', () => {
  it('derives both thresholds from centre ± length/2 along heading — due-east runway', () => {
    // Heading 90 (due east): the primary threshold is west of centre (an aircraft crosses
    // it, then rolls east toward the secondary end), the secondary threshold is east of it.
    const runway: ParsedRunway = {
      latitude: 51.0,
      longitude: 0.0,
      headingDeg: 90,
      lengthM: 2000,
      widthM: 45,
      surface: 2,
      primaryIdent: '09',
      secondaryIdent: '27'
    }
    const [primary, secondary] = runwayEndsFromCentre(runway)

    expect(primary!.ident).toBe('09')
    expect(primary!.headingTrueDeg).toBeCloseTo(90, 6)
    expect(primary!.thresholdLat).toBeCloseTo(51.0, 6)
    expect(primary!.thresholdLon).toBeCloseTo(-1000 / metersPerDegLon(51.0), 6)

    expect(secondary!.ident).toBe('27')
    expect(secondary!.headingTrueDeg).toBeCloseTo(270, 6)
    expect(secondary!.thresholdLat).toBeCloseTo(51.0, 6)
    expect(secondary!.thresholdLon).toBeCloseTo(1000 / metersPerDegLon(51.0), 6)
  })

  it('derives both thresholds along heading — due-north runway', () => {
    // Heading 0 (due north): the primary threshold is south of centre.
    const runway: ParsedRunway = {
      latitude: 51.0,
      longitude: 0.0,
      headingDeg: 0,
      lengthM: 3000,
      widthM: 45,
      surface: 2,
      primaryIdent: '36',
      secondaryIdent: '18'
    }
    const [primary, secondary] = runwayEndsFromCentre(runway)

    expect(primary!.thresholdLat).toBeCloseTo(51.0 - 1500 / METERS_PER_DEG_LAT, 6)
    expect(primary!.thresholdLon).toBeCloseTo(0.0, 6)
    expect(secondary!.thresholdLat).toBeCloseTo(51.0 + 1500 / METERS_PER_DEG_LAT, 6)
    expect(secondary!.headingTrueDeg).toBeCloseTo(180, 6)
  })

  it('carries length/width/surface through to both ends unchanged', () => {
    const runway: ParsedRunway = {
      latitude: 0,
      longitude: 0,
      headingDeg: 45,
      lengthM: 2500,
      widthM: 60,
      surface: 5,
      primaryIdent: '04',
      secondaryIdent: '22'
    }
    for (const end of runwayEndsFromCentre(runway)) {
      expect(end.lengthM).toBe(2500)
      expect(end.widthM).toBe(60)
      expect(end.surface).toBe(5)
    }
  })
})
