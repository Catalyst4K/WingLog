import { describe, expect, it } from 'vitest'
import type { NavdataRunway } from '@shared/ipc'
import { landingRunwayResolver } from './landing-runway'
import { distanceFromUsableThresholdM } from './runway-lookup'
import { offsetAlongBearing, positionRelativeToRunway } from './landing-maths'

// WSSS 20R from the sim's own facility data (flight 236), and where the A380 touched down on it: 949 m past the sim's
// threshold, 1.9 m left of its centreline. OurAirports' 20R is the same strip 40 m to the east, with a 740 m displaced threshold.
const SIM_20R: NavdataRunway = {
  ident: '20R',
  headingTrueDeg: 203,
  lengthM: 3221.2,
  widthM: 60,
  surface: 4,
  thresholdLat: 1.3757575921283205,
  thresholdLon: 103.98878019536174
}
const TOUCHDOWN = { lat: 1.367905765723336, lon: 103.98546445983592, headingDeg: 203.03 }

describe('landingRunwayResolver', () => {
  it("measures against the sim's runway when it is cached, and says so", () => {
    const end = landingRunwayResolver([SIM_20R])('WSSS', TOUCHDOWN.headingDeg, TOUCHDOWN.lat, TOUCHDOWN.lon)
    expect(end?.ident).toBe('20R')
    expect(end?.source).toBe('sim')
    expect(end?.displacedThresholdM).toBe(0)
  })

  it('falls back to the airport database when the sim has nothing cached for the airport', () => {
    const end = landingRunwayResolver([])('WSSS', TOUCHDOWN.headingDeg, TOUCHDOWN.lat, TOUCHDOWN.lon)
    expect(end?.ident).toBe('20R')
    expect(end?.source).toBe('database')
  })

  it("falls back to the airport database when the sim's cached runways don't fit the touchdown", () => {
    // Only the parallel 20L cached: the touchdown is nowhere near it, but the database knows 20R.
    const other: NavdataRunway = { ...SIM_20R, ident: '20L', thresholdLat: 1.3557, thresholdLon: 104.0139 }
    const end = landingRunwayResolver([other])('WSSS', TOUCHDOWN.headingDeg, TOUCHDOWN.lat, TOUCHDOWN.lon)
    expect(end?.source).toBe('database')
  })

  it('finds nothing where neither knows the airport', () => {
    expect(landingRunwayResolver([])('ZZZZ', 90, 10, 10)).toBeNull()
  })

  it('measures a landing from the landing threshold when the sim states a displaced one (Bergen 17, flight 242)', () => {
    // The sim's Bergen 17 is the whole strip with 270 m displaced; the touchdown was 730 m from its end.
    const bergen17: NavdataRunway = {
      ident: '17',
      headingTrueDeg: 170.5601806640625,
      lengthM: 2982.910400390625,
      widthM: 45.24,
      surface: 4,
      thresholdLat: 60.306639864245795,
      thresholdLon: 5.21371178198079,
      displacedThresholdM: 270
    }
    const touchdown = offsetAlongBearing(
      bergen17.thresholdLat,
      bergen17.thresholdLon,
      bergen17.headingTrueDeg,
      730.27
    )
    const end = landingRunwayResolver([bergen17])('ENBR', 170.53, touchdown.lat, touchdown.lon)
    expect(end?.source).toBe('sim')
    expect(end?.displacedThresholdM).toBe(270)
    const position = positionRelativeToRunway(
      touchdown.lat,
      touchdown.lon,
      end!.lat,
      end!.lon,
      end!.headingTrueDeg
    )
    expect(position.distanceFromThresholdM).toBeCloseTo(730.27, 0)
    expect(distanceFromUsableThresholdM(position, end!)).toBeCloseTo(460.27, 0)
  })
})
