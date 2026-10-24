/**
 * A small synthetic airport for the taxi generator's and the fuzz's tests (scripts/sim/taxi-generate.test.ts, taxi-fuzz.test.ts), one a test can
 * reason about exactly. East-west taxiways A (north 0) and B (north 300), 2 km long, joined by links L1 (east 400) and L2 (east 1600). Runway
 * 09/27 along north -300. Exits E1 (east 200) and E2 (east 1800) from A to the runway, each with a hold short 100 m from it. A second runway,
 * 18, runs north-south at east 1100 across both taxiways, with hold shorts either side. Stands north of B, each on an unnamed lead-in.
 */
import type { NavdataRunway, NavdataStand, NavdataTaxiSegment } from '../../src/shared/ipc'
import { offsetBy } from '../../src/shared/geo'
import type { GeneratorAirport } from './taxi-generate'

export const ORIGIN = { lat: 50, lon: 0 }
export const at = (eastM: number, northM: number): { lat: number; lon: number } =>
  offsetBy(ORIGIN, eastM, northM)

let holdShorts = new Set<string>()
export const seg = (
  from: [number, number],
  to: [number, number],
  name: string | null
): NavdataTaxiSegment => {
  const a = at(...from)
  const b = at(...to)
  return {
    startLat: a.lat,
    startLon: a.lon,
    endLat: b.lat,
    endLon: b.lon,
    name,
    startHoldShort: holdShorts.has(from.join()),
    endHoldShort: holdShorts.has(to.join())
  }
}

/** A string of segments along a line, one every 200 m. */
export function line(
  from: [number, number],
  to: [number, number],
  name: string | null,
  step = 200
): NavdataTaxiSegment[] {
  const n = Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / step)
  return Array.from({ length: n }, (_, i) =>
    seg(
      [from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n],
      [from[0] + ((to[0] - from[0]) * (i + 1)) / n, from[1] + ((to[1] - from[1]) * (i + 1)) / n],
      name
    )
  )
}

/**
 * (see the file header) East-west taxiways A (north 0) and B (north 300), 2 km long, joined by links L1 (east 400) and L2 (east 1600). Runway
 * 09/27 along north -300. Exits E1 (east 200) and E2 (east 1800) from A to the runway, each with a hold short 100 m from it. A second
 * runway, 18, runs north-south at east 1100 across both taxiways, with hold shorts either side. Stands north of B, each on an unnamed lead-in.
 */
export function airport(): GeneratorAirport {
  holdShorts = new Set(['200,-200', '1800,-200', '1000,0', '1200,0', '1000,300', '1200,300'])
  const segments = [
    ...line([0, 0], [2000, 0], 'A'),
    ...line([0, 300], [2000, 300], 'B'),
    ...line([400, 0], [400, 300], 'L1', 150),
    ...line([1600, 0], [1600, 300], 'L2', 150),
    seg([200, 0], [200, -200], 'E1'),
    seg([200, -200], [200, -300], 'E1'),
    seg([1800, 0], [1800, -200], 'E2'),
    seg([1800, -200], [1800, -300], 'E2'),
    ...[200, 600, 1000, 1400, 1800].map((east) => seg([east, 300], [east, 400], null))
  ]
  const runway = (ident: string, east: number, heading: number): NavdataRunway => {
    const t = at(east, -300)
    return {
      ident,
      headingTrueDeg: heading,
      lengthM: 2000,
      widthM: 45,
      surface: 0,
      thresholdLat: t.lat,
      thresholdLon: t.lon,
      displacedThresholdM: null
    } as NavdataRunway
  }
  const crossing = at(1100, 700)
  const stands: NavdataStand[] = [200, 600, 1000, 1400, 1800].map((east, i) => {
    const p = at(east, 400)
    return { name: `N${i + 1}`, number: i + 1, suffix: 0, headingDeg: 0, lat: p.lat, lon: p.lon }
  })
  return {
    icao: 'TEST',
    segments,
    runways: [
      runway('09', 0, 90),
      runway('27', 2000, 270),
      {
        ident: '18',
        headingTrueDeg: 180,
        lengthM: 1400,
        widthM: 45,
        surface: 0,
        thresholdLat: crossing.lat,
        thresholdLon: crossing.lon,
        displacedThresholdM: null
      } as NavdataRunway
    ],
    stands
  }
}
