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
  let trackingPoint: (point: TrackPoint) => void = () => undefined
  const getActive = vi.fn().mockResolvedValue(ACTIVE)
  window.winglog = {
    aircraftList: vi.fn().mockResolvedValue([]),
    flightList: vi.fn().mockResolvedValue([]),
    trackingGetActive: getActive,
    trackPointList: vi.fn().mockResolvedValue([POINT]),
    onTrackingPoint: vi.fn((listener: (point: TrackPoint) => void) => {
      trackingPoint = listener
      return () => undefined
    }),
    onTrackingPointsUpdated: vi.fn(() => () => undefined),
    onDataChanged: vi.fn((listener: () => void) => {
      dataChanged = listener
      return () => undefined
    })
  } as unknown as WingLogApi
  return {
    getActive,
    dataChanged: () => act(async () => dataChanged()),
    trackingPoint: (point: TrackPoint) => act(() => trackingPoint(point))
  }
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
  it('shows the new flight and its track when a different flight is now the one tracked', async () => {
    const pc = withWinglog()
    const { result } = renderHook(() => useTrackedFlights(undefined))
    await act(async () => undefined)
    const other = { flightId: 8, phase: 'taxi' } as ActiveTracking
    const otherPoint = { id: 2, flightId: 8, phase: 'taxi' } as unknown as TrackPoint
    pc.getActive.mockResolvedValue(other)
    window.winglog.trackPointList = vi.fn().mockResolvedValue([otherPoint])
    await pc.dataChanged()
    expect(result.current.active).toEqual(other)
    expect(result.current.trackPoints).toEqual([otherPoint])
  })

  it('does not draw the track of a flight that shut down while its points were being read', async () => {
    const pc = withWinglog()
    pc.getActive.mockResolvedValue(null)
    const { result } = renderHook(() => useTrackedFlights(undefined))
    await act(async () => undefined)
    let release: (points: TrackPoint[]) => void = () => undefined
    window.winglog.trackPointList = vi.fn(() => new Promise<TrackPoint[]>((resolve) => (release = resolve)))
    pc.getActive.mockResolvedValue(ACTIVE)
    // A sync shows the sim PC's flight, and its track is being read when the flight ends.
    const changed = pc.dataChanged()
    await act(async () => undefined)
    await pc.trackingPoint({ ...POINT, phase: 'shutdown' })
    await act(async () => release([POINT]))
    await changed
    expect(result.current.active).toBeNull()
    expect(result.current.trackPoints).toEqual([])
  })
})
