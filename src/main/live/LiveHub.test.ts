import { describe, expect, it, vi } from 'vitest'
import type { LiveTopics } from '@shared/live'
import { EMPTY_STATE as BEYONDATC_EMPTY_STATE } from '../beyondatc/BeyondAtcService'
import { LiveHub } from './LiveHub'

// A real-shaped sample: the A350 at VHHH stand N32, 2026-10-02.
const POINT: LiveTopics['trackingPoint'] = {
  id: 86618,
  flightId: 216,
  tsUtc: '2026-10-02T10:41:07.000Z',
  latitude: 22.31404,
  longitude: 113.92867,
  altitudeM: 8.5,
  pressureAltitudeM: 61,
  altitudeAglM: 0,
  indicatedAirspeedMs: 0,
  machSpeed: 0,
  groundSpeedMs: 0,
  verticalSpeedMs: 0,
  headingTrueDeg: 161,
  pitchDeg: 0.4,
  bankDeg: 0,
  phase: 'shutdown',
  onGround: true,
  fuelKg: 7120,
  gForce: 1,
  windSpeedMs: 3.1,
  windDirectionDeg: 70,
  resumeSegment: 0,
  simRate: 1,
  excludedReason: null
}

describe('LiveHub', () => {
  it('passes each publish to every subscriber, and stops after unsubscribe', () => {
    const hub = new LiveHub()
    const window = vi.fn()
    const lan = vi.fn()
    hub.subscribe(window)
    const stopLan = hub.subscribe(lan)

    hub.publish('trackingPoint', POINT)
    expect(window).toHaveBeenCalledWith('trackingPoint', POINT)
    expect(lan).toHaveBeenCalledWith('trackingPoint', POINT)

    stopLan()
    hub.publish('beyondAtcState', BEYONDATC_EMPTY_STATE)
    expect(window).toHaveBeenCalledTimes(2)
    expect(lan).toHaveBeenCalledTimes(1)
  })

  it('keeps the latest payload per topic, so a late joiner gets the current state', () => {
    const hub = new LiveHub()
    hub.publish('beyondAtcStatus', { state: 'connecting', lastError: null })
    hub.publish('beyondAtcStatus', { state: 'connected', lastError: null })
    hub.publish('trackingPoint', POINT)

    expect(hub.snapshot()).toEqual({ beyondAtcStatus: { state: 'connected', lastError: null }, trackingPoint: POINT })
    // A copy: changing it doesn't change the hub.
    const snap = hub.snapshot()
    delete snap.trackingPoint
    expect(hub.snapshot().trackingPoint).toEqual(POINT)
  })

  it("keeps going when one subscriber throws (a closed window mustn't cut off the rest)", () => {
    const hub = new LiveHub()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const after = vi.fn()
    hub.subscribe(() => {
      throw new Error('Object has been destroyed')
    })
    hub.subscribe(after)
    hub.publish('trackingPoint', POINT)
    expect(after).toHaveBeenCalledWith('trackingPoint', POINT)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('carries payloads that survive JSON unchanged, so any transport (a LAN socket later) can send them', () => {
    const hub = new LiveHub()
    hub.publish('trackingPoint', POINT)
    hub.publish('trackingPointsUpdated', [POINT, { ...POINT, id: 86619, excludedReason: 'resume-spurious' }])
    hub.publish('beyondAtcState', BEYONDATC_EMPTY_STATE)
    hub.publish('beyondAtcTranscript', [{ speaker: 'atc', text: 'Cathay 168 Heavy, taxi to Stand N32 via J, H6, H, V, B.', ts: 1759401600000 }])
    hub.publish('gsxRemoteGate', null)
    const snapshot = hub.snapshot()
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
  })
})
