import { describe, expect, it } from 'vitest'
import type { RunwayStrip, TracedRoute } from './route-types'
import { alongAndAcross } from './runway-crossing'
import { HOLD_OFF_RUNWAY_M, endOffRunway, stripOf } from './runway-trim'

// A runway pointing north from the equator at the prime meridian, 3 km long and 50 m wide: metres north are "along" it, metres east "across".
const RUNWAY: RunwayStrip = { thresholdLat: 0, thresholdLon: 0, headingTrueDeg: 0, lengthM: 3000, widthM: 50 }
const M = 111_320
/** A [lon, lat] point this many metres along and across the runway. */
const at = (along: number, across: number): [number, number] => [across / M, along / M]
const acrossOf = (point: [number, number] | undefined): number =>
  alongAndAcross({ lat: point?.[1] ?? 0, lon: point?.[0] ?? 0 }, RUNWAY).across

describe('endOffRunway', () => {
  // EGLL, 2026-11-07: "taxi to holding point A1, runway 27R" traced to A1's far end, on the centreline 150 m along the runway.
  it('cuts a line that runs onto the runway back to the margin outside its edge, on the way it came', () => {
    const route: TracedRoute = [
      at(0, -200),
      at(100, -120),
      at(100, -80),
      at(110, -40),
      at(120, 0),
      at(150, 0)
    ]
    const cut = endOffRunway(route, [RUNWAY])
    expect(cut.slice(0, 2)).toEqual(route.slice(0, 2))
    expect(Math.abs(acrossOf(cut.at(-1)))).toBeCloseTo(25 + HOLD_OFF_RUNWAY_M, 3)
    // On the segment from the last point outside, not somewhere else.
    expect(cut.at(-1)?.[1]).toBeGreaterThan(100 / M)
    expect(cut.at(-1)?.[1]).toBeLessThan(110 / M)
  })

  it('leaves a line that already ends outside the margin as it is', () => {
    const route: TracedRoute = [at(0, -200), at(100, -120), at(100, -80)]
    expect(endOffRunway(route, [RUNWAY])).toBe(route)
  })

  it('leaves a line whose end is beside no runway as it is', () => {
    const route: TracedRoute = [at(-500, -10), at(-400, 0)]
    expect(endOffRunway(route, [RUNWAY])).toBe(route)
  })

  it('leaves a line that crosses a runway part-way, cutting only an end that is on one', () => {
    const route: TracedRoute = [at(500, -100), at(500, 100), at(500, 200)]
    expect(endOffRunway(route, [RUNWAY])).toBe(route)
  })

  it('does not cut a line that has been on the runway from its first point', () => {
    const route: TracedRoute = [at(100, 0), at(200, 0)]
    expect(endOffRunway(route, [RUNWAY])).toBe(route)
  })

  it('does nothing when the airport has no runways in its data', () => {
    const route: TracedRoute = [at(0, -200), at(100, 0)]
    expect(endOffRunway(route, [])).toBe(route)
  })
})

describe('stripOf', () => {
  it('keeps just what a strip is', () => {
    const strip = stripOf({ ...RUNWAY, ident: '36', surface: 4, displacedThresholdM: 100 } as never)
    expect(strip).toEqual(RUNWAY)
  })
})
