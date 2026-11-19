import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ActiveTracking, TrackPoint, WingLogApi } from '@shared/ipc'
import { useTrackedFlights } from './use-track-state'

const ACTIVE: ActiveTracking = { flightId: 7, phase: 'cruise' }
const POINT = { id: 1, flightId: 7, phase: 'cruise' } as unknown as TrackPoint

/**
 * A window.winglog for a window whose flight is stopped or finished by another WingLog (a Mac pressing Cancel), so no button here was pressed.
 *
 * @returns What the main process answers about the active flight (settable), and the way to tell the window its data changed.
 */
function withWinglog() {
  let dataChanged: () => void = () => undefined
  const getActive = vi.fn().mockResolvedValue(ACTIVE)
  window.winglog = {
    aircraftList: vi.fn().mockResolvedValue([]),
    flightList: vi.fn().mockResolvedValue([]),
    trackingGetActive: getActive,
    trackPointList: vi.fn().mockResolvedValue([POINT]),
    onTrackingPoint: vi.fn(() => () => undefined),
    onTrackingPointsUpdated: vi.fn(() => () => undefined),
    onDataChanged: vi.fn((listener: () => void) => {
      dataChanged = listener
      return () => undefined
    })
  } as unknown as WingLogApi
  return { getActive, dataChanged: () => act(async () => dataChanged()) }
}

describe('useTrackedFlights: a flight ended by another WingLog', () => {
  afterEach(() => vi.restoreAllMocks())

  it('stops showing a flight the sim PC no longer tracks once the window is told its data changed', async () => {
    const pc = withWinglog()
    const { result } = renderHook(() => useTrackedFlights(undefined))
    await act(async () => undefined)
    expect(result.current.active).toEqual(ACTIVE)
    expect(result.current.trackPoints).toHaveLength(1)
    pc.getActive.mockResolvedValue(null)
    await pc.dataChanged()
    expect(result.current.active).toBeNull()
    expect(result.current.trackPoints).toEqual([])
  })

  it('does not read the whole track again for a change that leaves the same flight tracked', async () => {
    const pc = withWinglog()
    const { result } = renderHook(() => useTrackedFlights(undefined))
    await act(async () => undefined)
    await pc.dataChanged()
    expect(window.winglog.trackPointList).toHaveBeenCalledTimes(1)
    expect(result.current.active).toEqual(ACTIVE)
  })
})
