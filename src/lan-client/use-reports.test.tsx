import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { LiveTopic, TaxiRoute } from '@shared/live'
import type { LanConnection } from './lan-connection'
import { useReportScriptErrors, useReportTaxiRoute } from './use-reports'

function fakeLink() {
  let route: TaxiRoute | null | undefined
  const listeners = new Set<() => void>()
  const report = vi.fn()
  const link = {
    report,
    latest: (topic: LiveTopic) => (topic === 'taxiRoute' ? route : undefined),
    subscribe: (_topic: LiveTopic, listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as LanConnection
  return {
    link,
    report,
    pcSends: (next: TaxiRoute | null) => {
      route = next
      for (const listener of listeners) listener()
    }
  }
}

const taxi = (revision: number, kind: TaxiRoute['kind'] = 'exact'): TaxiRoute => ({
  flightId: 1,
  icao: 'ZJSY',
  revision,
  kind,
  line: kind ? [[109.4, 18.3]] : [],
  clearance: { taxiways: ['D'], holdingPoint: 'A', stand: null, holdShortRunway: null }
})

describe('useReportTaxiRoute', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('tells the PC the first taxi line it takes, by revision', () => {
    const t = fakeLink()
    renderHook(() => useReportTaxiRoute(t.link))
    expect(t.report).not.toHaveBeenCalled()
    act(() => t.pcSends(taxi(3)))
    expect(t.report).toHaveBeenCalledWith('taxi-route-applied', 'r3')
  })

  it('does not say it again for every line the PC pushes in a taxi, but does after a while', () => {
    const t = fakeLink()
    renderHook(() => useReportTaxiRoute(t.link))
    act(() => t.pcSends(taxi(3)))
    for (let revision = 4; revision < 12; revision++) {
      vi.advanceTimersByTime(1000)
      act(() => t.pcSends(taxi(revision)))
    }
    expect(t.report).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_000)
    act(() => t.pcSends(taxi(20)))
    expect(t.report).toHaveBeenCalledTimes(2)
    expect(t.report).toHaveBeenLastCalledWith('taxi-route-applied', 'r20')
  })

  it('says nothing for no route, or one with no line found', () => {
    const t = fakeLink()
    renderHook(() => useReportTaxiRoute(t.link))
    act(() => t.pcSends(null))
    act(() => t.pcSends(taxi(5, null)))
    expect(t.report).not.toHaveBeenCalled()
  })
})

describe('useReportScriptErrors', () => {
  it('tells the PC when script on the page throws, with the message and no stack', () => {
    const t = fakeLink()
    renderHook(() => useReportScriptErrors(t.link))
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'Uncaught TypeError: x is not a function', error: new Error('x') })
    )
    expect(t.report).toHaveBeenCalledWith('script-error', 'Uncaught TypeError: x is not a function')
  })

  it('tells the PC about a promise rejected with nobody listening, from an error or from anything else', () => {
    const t = fakeLink()
    renderHook(() => useReportScriptErrors(t.link))
    const rejection = (reason: unknown): Event => Object.assign(new Event('unhandledrejection'), { reason })
    window.dispatchEvent(rejection(new RangeError('too big')))
    window.dispatchEvent(rejection('plain text'))
    expect(t.report).toHaveBeenNthCalledWith(1, 'script-error', 'Unhandled rejection: RangeError: too big')
    expect(t.report).toHaveBeenNthCalledWith(2, 'script-error', 'Unhandled rejection: plain text')
  })

  it('stops listening when the page goes', () => {
    const t = fakeLink()
    const { unmount } = renderHook(() => useReportScriptErrors(t.link))
    unmount()
    window.dispatchEvent(new ErrorEvent('error', { message: 'late' }))
    expect(t.report).not.toHaveBeenCalled()
  })
})
