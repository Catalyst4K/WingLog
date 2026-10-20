import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { LanFlightSnapshot } from '@shared/ipc'
import type { LiveTopic, PlannedRoute } from '@shared/live'
import type { LanConnection } from './lan-connection'
import { usePlannedWaypoints } from './use-planned-route'

const OFP = JSON.stringify({
  navlog: {
    fix: [
      { ident: 'SIMBRIEF', pos_lat: '1', pos_long: '2', altitude_feet: '3000' },
      { ident: 'DEST', pos_lat: '3', pos_long: '4', altitude_feet: '0' }
    ]
  }
})
const snapshot = (flightId: number, ofpJson: string | null = OFP): LanFlightSnapshot =>
  ({ flight: { flightId, ofpJson }, trackPoints: [] }) as unknown as LanFlightSnapshot

function fakeLink() {
  let route: PlannedRoute | undefined
  const listeners = new Set<() => void>()
  const report = vi.fn()
  const link = {
    report,
    latest: (topic: LiveTopic) => (topic === 'plannedRoute' ? route : undefined),
    subscribe: (_topic: LiveTopic, listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as LanConnection
  return {
    link,
    report,
    pcSends: (next: PlannedRoute) => {
      route = next
      for (const listener of listeners) listener()
    }
  }
}

const route = (flightId: number, idents: string[]): PlannedRoute => ({
  flightId,
  revision: 1,
  selection: {} as never,
  waypoints: idents.map((ident, i) => ({ ident, lon: i, lat: i, altitudeFt: 0, segment: 'enroute' as const }))
})

describe('usePlannedWaypoints', () => {
  it('is empty with no flight, and says nothing about a missing route', () => {
    vi.useFakeTimers()
    try {
      const t = fakeLink()
      const { result } = renderHook(() => usePlannedWaypoints(t.link, null))
      expect(result.current).toEqual([])
      act(() => void vi.advanceTimersByTime(60_000))
      expect(t.report).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("stands in with SimBrief's own route until the PC sends one, then draws the PC's", () => {
    const t = fakeLink()
    const { result } = renderHook(() => usePlannedWaypoints(t.link, snapshot(7)))
    expect(result.current.map((w) => w.ident)).toEqual(['SIMBRIEF', 'DEST'])
    act(() => t.pcSends(route(7, ['PC1', 'PC2', 'PC3'])))
    expect(result.current.map((w) => w.ident)).toEqual(['PC1', 'PC2', 'PC3'])
  })

  it('never draws a route built for another flight', () => {
    const t = fakeLink()
    t.pcSends(route(8, ['OTHER']))
    const { result } = renderHook(() => usePlannedWaypoints(t.link, snapshot(7)))
    expect(result.current.map((w) => w.ident)).toEqual(['SIMBRIEF', 'DEST'])
  })

  it('tells the PC when a flight has been shown for ten seconds with no route for it, once', () => {
    vi.useFakeTimers()
    try {
      const t = fakeLink()
      renderHook(() => usePlannedWaypoints(t.link, snapshot(7)))
      act(() => void vi.advanceTimersByTime(9999))
      expect(t.report).not.toHaveBeenCalled()
      act(() => void vi.advanceTimersByTime(1))
      expect(t.report).toHaveBeenCalledTimes(1)
      expect(t.report).toHaveBeenCalledWith('route-missing')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not tell the PC when the route arrives in time', () => {
    vi.useFakeTimers()
    try {
      const t = fakeLink()
      renderHook(() => usePlannedWaypoints(t.link, snapshot(7)))
      act(() => void vi.advanceTimersByTime(5000))
      act(() => t.pcSends(route(7, ['PC1'])))
      act(() => void vi.advanceTimersByTime(60_000))
      expect(t.report).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
