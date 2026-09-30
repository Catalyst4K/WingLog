import { describe, expect, it } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { traceTaxiRoute } from './taxiRouteTrace'
import VHHH_RAW from './__fixtures__/vhhh-taxi-b8-b10.json'

// Real VHHH taxi network (MSFS facility data, fetched live 2026-09-30), trimmed to the ~1.2 km
// box around the east end of runway 25C. Rows: [startLat, startLon, endLat, endLon, name,
// startHoldShort, endHoldShort].
const VHHH = (VHHH_RAW as [number, number, number, number, string | null, number, number][]).map(
  ([startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort]): NavdataTaxiSegment => ({
    startLat,
    startLon,
    endLat,
    endLon,
    name,
    startHoldShort: startHoldShort === 1,
    endHoldShort: endHoldShort === 1
  })
)

// The far (stand) end of B8, and B10's real hold-short point on runway 25C.
const STAND_END_OF_B8 = { lat: 22.3151936, lon: 113.9290456 }
const B10_HOLD_SHORT: [number, number] = [113.9325748, 22.3209537]

function lengthM(route: [number, number][]): number {
  let total = 0
  for (let i = 1; i < route.length; i++) {
    const [lonA, latA] = route[i - 1]!
    const [lonB, latB] = route[i]!
    total += Math.hypot((latA - latB) * 111_320, (lonA - lonB) * 111_320 * Math.cos((latA * Math.PI) / 180))
  }
  return total
}

describe('traceTaxiRoute', () => {
  it('traces the real VHHH clearance "holding point B10, runway 25C, via B8, B" to the B10 hold (real bug, 2026-09-30)', () => {
    const route = traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B'], holdingPoint: 'B10', from: STAND_END_OF_B8 })

    expect(route).not.toBeNull()
    expect(route!.at(-1)).toEqual(B10_HOLD_SHORT)
    // Matches the offline spike against the full network (~872 m) — not the ~3.9 km of all
    // of B that the old whole-name highlight lit up.
    expect(lengthM(route!)).toBeGreaterThan(800)
    expect(lengthM(route!)).toBeLessThan(950)
  })

  it('bridges the scenery-only "B12" stretch between B and B10 that ATC never names', () => {
    const route = traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B'], holdingPoint: 'B10', from: STAND_END_OF_B8 })!
    const onRoute = new Set(route.map(([lon, lat]) => `${lon},${lat}`))
    const b12Used = VHHH.filter((s) => s.name === 'B12').some(
      (s) => onRoute.has(`${s.startLon},${s.startLat}`) && onRoute.has(`${s.endLon},${s.endLat}`)
    )
    expect(b12Used).toBe(true)
  })

  it('accepts a clearance that already lists the holding point as its last taxiway', () => {
    const route = traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B', 'B10'], holdingPoint: 'B10', from: STAND_END_OF_B8 })
    expect(route!.at(-1)).toEqual(B10_HOLD_SHORT)
  })

  it('returns null (caller falls back to whole-name highlight) when there is no holding point', () => {
    expect(traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B'], holdingPoint: null, from: STAND_END_OF_B8 })).toBeNull()
  })

  it('returns null when the holding point is not a taxiway with a hold-short point', () => {
    expect(traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B'], holdingPoint: 'Z9', from: STAND_END_OF_B8 })).toBeNull()
    const noHoldFlags = VHHH.map((s) => ({ ...s, startHoldShort: false, endHoldShort: false }))
    expect(traceTaxiRoute({ segments: noHoldFlags, taxiways: ['B8', 'B'], holdingPoint: 'B10', from: STAND_END_OF_B8 })).toBeNull()
  })

  it('returns null when the aircraft is nowhere near the taxi network', () => {
    expect(traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B'], holdingPoint: 'B10', from: { lat: 22.4, lon: 114.1 } })).toBeNull()
  })
})

describe('traceTaxiRoute on a hand-built junction', () => {
  const seg = (a: [number, number], b: [number, number], name: string | null, endHoldShort = false): NavdataTaxiSegment => ({
    startLat: a[0],
    startLon: a[1],
    endLat: b[0],
    endLon: b[1],
    name,
    startHoldShort: false,
    endHoldShort
  })

  it('never drives out along a taxiway and straight back just to "use" it', () => {
    // The hold on A1 leaves right at the D/B junction; B only runs away from it.
    const route = traceTaxiRoute({
      segments: [
        seg([51.33, 0.03], [51.331, 0.031], 'D'),
        seg([51.331, 0.031], [51.34, 0.05], 'B'),
        seg([51.331, 0.031], [51.3315, 0.0315], 'A1', true)
      ],
      taxiways: ['D', 'B'],
      holdingPoint: 'A1',
      from: { lat: 51.33, lon: 0.03 }
    })
    expect(route?.some(([lon]) => lon === 0.05) ?? false).toBe(false)
  })
})
