import { describe, expect, it } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { furthestBackHold, startOfRunwayHolds } from './runway-hold'
import { traceTaxiRoute } from './route-trace'

// WSSS runway 02C from the sim's own data (2026-10-19): threshold, and the hold shorts beside it on the side the flown taxi came from
// (T11 and T12 are entries part-way along the runway; the unnamed one is the entry behind the threshold that was flown to).
const THRESHOLD = { lat: 1.3289066609787161, lon: 103.98500127127546, headingDeg: 23 }
const T11 = { lat: 1.33067, lon: 103.98455 }
const T12 = { lat: 1.32958, lon: 103.98408 }
const LAST = { lat: 1.32854, lon: 103.98349 }
// The same side's other neighbours, and the far side of the runway.
const FAR_SIDE = { lat: 1.32872, lon: 103.98608 }

const hold = (at: { lat: number; lon: number }): NavdataTaxiSegment => ({
  startLat: at.lat - 0.0003,
  startLon: at.lon,
  endLat: at.lat,
  endLon: at.lon,
  name: null,
  startHoldShort: false,
  endHoldShort: true
})

describe('furthestBackHold', () => {
  const segments = [T11, T12, LAST, FAR_SIDE].map(hold)

  it('goes on from the first hold short reached (T11) to the entry behind the threshold, on the same side (WSSS 02C)', () => {
    const further = furthestBackHold(segments, T11, THRESHOLD)
    expect(further?.lat).toBeCloseTo(LAST.lat, 5)
    expect(further?.lon).toBeCloseTo(LAST.lon, 5)
  })

  it('never crosses to the far side of the runway', () => {
    expect(furthestBackHold([hold(T11), hold(FAR_SIDE)], T11, THRESHOLD)).toBeNull()
  })

  it('finds nothing further back when the first one reached is already the last', () => {
    expect(furthestBackHold(segments, LAST, THRESHOLD)).toBeNull()
  })

  it('does nothing without the runway heading, or with no hold short near the threshold', () => {
    expect(furthestBackHold(segments, T11, { lat: THRESHOLD.lat, lon: THRESHOLD.lon })).toBeNull()
    expect(furthestBackHold([hold({ lat: 1.35, lon: 103.99 })], T11, THRESHOLD)).toBeNull()
  })
})

describe('startOfRunwayHolds', () => {
  it('is the entry behind the threshold on each side of the runway (WSSS 02C), never a part-way entry', () => {
    const found = startOfRunwayHolds([T11, T12, LAST, FAR_SIDE].map(hold), THRESHOLD)
    expect(found).toHaveLength(2)
    expect(found).toContainEqual({ lat: LAST.lat, lon: LAST.lon })
    expect(found).toContainEqual({ lat: FAR_SIDE.lat, lon: FAR_SIDE.lon })
  })

  it('is every hold short near the threshold when the runway heading is not known, and none when there are none', () => {
    const noHeading = { lat: THRESHOLD.lat, lon: THRESHOLD.lon }
    expect(startOfRunwayHolds([T12, LAST].map(hold), noHeading)).toHaveLength(2)
    expect(startOfRunwayHolds([hold({ lat: 1.35, lon: 103.99 })], THRESHOLD)).toEqual([])
  })
})

describe('traceTaxiRoute to the last hold short beside a runway (WSSS 2026-10-19)', () => {
  const seg = (
    a: [number, number],
    b: [number, number],
    name: string | null,
    endHoldShort = false
  ): NavdataTaxiSegment => ({
    startLat: a[0],
    startLon: a[1],
    endLat: b[0],
    endLon: b[1],
    name,
    startHoldShort: false,
    endHoldShort
  })
  const metres = (m: number): number => m / 111_320
  // A runway threshold at the origin pointing north; a taxiway T alongside it, 190 m to its left, running south; entries to the runway
  // at 160 m along (hold short A), 30 m along (hold short B) and 100 m before the threshold (hold short C, the last).
  const threshold = { lat: 51, lon: 0, headingDeg: 0 }
  const T0: [number, number] = [51 + metres(800), -metres(190)]
  const TA: [number, number] = [51 + metres(160), -metres(190)]
  const TB: [number, number] = [51 + metres(30), -metres(190)]
  const TC: [number, number] = [51 - metres(100), -metres(190)]
  const A: [number, number] = [51 + metres(160), -metres(100)]
  const B: [number, number] = [51 + metres(30), -metres(100)]
  const C: [number, number] = [51 - metres(100), -metres(100)]
  const request = {
    segments: [
      seg(T0, TA, 'T'),
      seg(TA, TB, 'T'),
      seg(TB, TC, 'T'),
      seg(TA, A, null, true),
      seg(TB, B, null, true),
      seg(TC, C, null, true)
    ],
    taxiways: ['T'],
    holdingPoint: 'T',
    from: { lat: T0[0], lon: T0[1] }
  }

  it('ends at the first hold short beside the runway when only the threshold is known', () => {
    const route = traceTaxiRoute({ ...request, runwayThreshold: { lat: threshold.lat, lon: threshold.lon } })
    expect(route?.at(-1)).toEqual([A[1], A[0]])
  })

  it('goes on to the last, behind the threshold, when the runway heading is known', () => {
    const route = traceTaxiRoute({ ...request, runwayThreshold: threshold })
    expect(route?.at(-1)).toEqual([C[1], C[0]])
  })
})
