import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { NavdataRunwayOption } from '@shared/ipc'
import type { TaxiClearance } from './taxi-clearance'
import { useClearanceRunway, useHoldShortRunway } from './use-taxi-route-highlight'

// EGCC 05L from the sim's own runway data (2026-10-17).
const RUNWAY_05L: NavdataRunwayOption = {
  ident: '05L',
  headingTrueDeg: 51.06,
  lengthM: 3048.85,
  widthM: 45,
  surface: 4,
  thresholdLat: 53.345140869529,
  thresholdLon: -2.2927934260192853,
  displacedThresholdM: 427
}
const CLEARANCE: TaxiClearance = {
  taxiways: ['E', 'D', 'B', 'A'],
  holdingPoint: 'A',
  stand: null,
  holdShortRunway: null,
  taxiToRunway: '05L',
  from: { lat: 53.36099, lon: -2.27903 }
}

function stubRunways(runways: NavdataRunwayOption[]): ReturnType<typeof vi.fn> {
  const navdataListRunways = vi.fn().mockResolvedValue(runways)
  ;(window as unknown as { winglog: unknown }).winglog = { navdataListRunways }
  return navdataListRunways
}

afterEach(() => {
  delete (window as unknown as { winglog?: unknown }).winglog
})

describe('useClearanceRunway', () => {
  it('gives the same threshold object on every render, so the line is not traced again and again', async () => {
    stubRunways([RUNWAY_05L])
    const { result, rerender } = renderHook(() => useClearanceRunway(true, CLEARANCE, 'EGCC'))
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current).toEqual({
      lat: RUNWAY_05L.thresholdLat,
      lon: RUNWAY_05L.thresholdLon,
      headingDeg: RUNWAY_05L.headingTrueDeg
    })
    const first = result.current
    rerender()
    rerender()
    expect(result.current).toBe(first)
  })

  it('asks for nothing, and gives nothing, for a clearance with no holding point or runway, or with the chart off', () => {
    const listed = stubRunways([RUNWAY_05L])
    for (const [enabled, clearance] of [
      [false, CLEARANCE],
      [true, { ...CLEARANCE, holdingPoint: null }],
      [true, { ...CLEARANCE, taxiToRunway: null }],
      [true, null]
    ] as const) {
      const { result } = renderHook(() => useClearanceRunway(enabled, clearance, 'EGCC'))
      expect(result.current).toBeNull()
    }
    expect(listed).not.toHaveBeenCalled()
  })

  it('gives nothing, quietly, when the runway list cannot be had or does not name the runway', async () => {
    const listed = vi.fn().mockRejectedValue(new Error('no sim'))
    ;(window as unknown as { winglog: unknown }).winglog = { navdataListRunways: listed }
    const failing = renderHook(() => useClearanceRunway(true, CLEARANCE, 'EGCC'))
    await waitFor(() => expect(listed).toHaveBeenCalled())
    expect(failing.result.current).toBeNull()

    stubRunways([{ ...RUNWAY_05L, ident: '23R' }])
    const other = renderHook(() => useClearanceRunway(true, CLEARANCE, 'EGCC'))
    await new Promise((r) => setTimeout(r, 0))
    expect(other.result.current).toBeNull()
  })
})

// RKSI 34R from the sim's own runway data (2026-10-16).
const RUNWAY_34R: NavdataRunwayOption = {
  ident: '34R',
  headingTrueDeg: 325,
  lengthM: 4010,
  widthM: 60,
  surface: 4,
  thresholdLat: 37.44335,
  thresholdLon: 126.44177
}
const HOLD_SHORT: TaxiClearance = {
  taxiways: ['P8', 'P'],
  holdingPoint: null,
  stand: '236',
  holdShortRunway: '34R',
  from: { lat: 37.459, lon: 126.4242 }
}

describe('useHoldShortRunway', () => {
  it('gives the runway of a hold short, the same object on every render', async () => {
    stubRunways([RUNWAY_34R])
    const { result, rerender } = renderHook(() => useHoldShortRunway(true, HOLD_SHORT, 'RKSI'))
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current).toBe(RUNWAY_34R)
    rerender()
    expect(result.current).toBe(RUNWAY_34R)
  })

  it('asks for nothing for a holding-point clearance, no hold short, or the chart off', () => {
    const listed = stubRunways([RUNWAY_34R])
    for (const [enabled, clearance] of [
      [false, HOLD_SHORT],
      [true, { ...HOLD_SHORT, holdingPoint: 'P' }],
      [true, { ...HOLD_SHORT, holdShortRunway: null }],
      [true, null]
    ] as const) {
      const { result } = renderHook(() => useHoldShortRunway(enabled, clearance, 'RKSI'))
      expect(result.current).toBeNull()
    }
    expect(listed).not.toHaveBeenCalled()
  })
})
