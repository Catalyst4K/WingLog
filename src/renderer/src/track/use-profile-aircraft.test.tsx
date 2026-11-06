import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { SimTelemetry } from '@shared/ipc'
import { useProfileAircraft } from './use-profile-aircraft'

const TELEMETRY = { latitude: 51.5, longitude: -0.4, altitudeM: 3048 } as SimTelemetry

describe('useProfileAircraft', () => {
  it('is the aircraft’s position and altitude in feet while a flight is tracked', () => {
    const { result } = renderHook(() => useProfileAircraft(TELEMETRY, true))
    expect(result.current).toEqual({ lon: -0.4, lat: 51.5, altitudeFt: 10000 })
  })

  it('is nothing before tracking starts (the sim can hold stale values) or without a reading', () => {
    expect(renderHook(() => useProfileAircraft(TELEMETRY, false)).result.current).toBeNull()
    expect(renderHook(() => useProfileAircraft(null, true)).result.current).toBeNull()
    expect(renderHook(() => useProfileAircraft(undefined, true)).result.current).toBeNull()
  })

  it('keeps the same object while the reading does not change', () => {
    const { result, rerender } = renderHook(() => useProfileAircraft(TELEMETRY, true))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
