import { describe, expect, it } from 'vitest'
import type { TrackPoint } from '@shared/ipc'
import { filterVisibleTrackPoints } from './trackPointVisibility'

function point(overrides: Partial<TrackPoint> = {}): TrackPoint {
  return {
    id: 1,
    flightId: 1,
    tsUtc: '2026-09-13T12:00:00.000Z',
    latitude: 0,
    longitude: 0,
    altitudeM: 0,
    altitudeAglM: 0,
    indicatedAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    verticalSpeedMs: 0,
    headingTrueDeg: 0,
    pitchDeg: 0,
    bankDeg: 0,
    phase: 'cruise',
    onGround: false,
    fuelKg: 0,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    resumeSegment: 0,
    simRate: 1,
    excludedReason: null,
    ...overrides
  }
}

describe('filterVisibleTrackPoints', () => {
  it('keeps points with no excluded reason', () => {
    const points = [point({ id: 1 }), point({ id: 2 })]
    expect(filterVisibleTrackPoints(points)).toEqual(points)
  })

  it('drops points flagged resume-spurious or resume-superseded', () => {
    const clean = point({ id: 1 })
    const spurious = point({ id: 2, excludedReason: 'resume-spurious' })
    const superseded = point({ id: 3, excludedReason: 'resume-superseded' })
    const cleanAfter = point({ id: 4 })
    expect(filterVisibleTrackPoints([clean, spurious, superseded, cleanAfter])).toEqual([clean, cleanAfter])
  })

  it('returns an empty array for an empty input', () => {
    expect(filterVisibleTrackPoints([])).toEqual([])
  })
})
