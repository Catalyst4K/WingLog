import { describe, expect, it } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { traceClearanceDetailed, type TaxiClearance } from '@shared/taxi/clearance'
import ZJSY_RAW from '@shared/taxi/__fixtures__/zjsy-taxi-d-b7-a.json'
import { createTraceAnswerer } from './trace-worker'
import type { WorkerRequest } from './worker-protocol'

// ZJSY's real taxi network (MSFS facility data from WingLog's cache), as the taxi code's own tests use it.
type Row = [number, number, number, number, string | null, number, number]
const ZJSY: NavdataTaxiSegment[] = (ZJSY_RAW as Row[]).map(
  ([startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort]) => ({
    startLat,
    startLon,
    endLat,
    endLon,
    name,
    startHoldShort: startHoldShort === 1,
    endHoldShort: endHoldShort === 1
  })
)

/** "Taxi to holding point A, runway 08, via D, B7, A", the aircraft on D heading east. */
const CLEARANCE: TaxiClearance = {
  taxiways: ['D', 'B7', 'A'],
  holdingPoint: 'A',
  stand: null,
  holdShortRunway: null,
  taxiToRunway: '08',
  from: { lat: 18.3074072, lon: 109.4093493, headingDeg: 90 }
}

const request = (id: number, networkKey: number, withNetwork: boolean): WorkerRequest => ({
  id,
  networkKey,
  ...(withNetwork ? { segments: ZJSY } : {}),
  job: { clearance: CLEARANCE, stand: null, threshold: null, holdShortRunway: null }
})

describe('createTraceAnswerer', () => {
  it('traces a job exactly as the main thread would', () => {
    const answer = createTraceAnswerer()
    const reply = answer(request(1, 1, true))
    expect(reply).toEqual({ id: 1, result: traceClearanceDetailed(CLEARANCE, ZJSY, null, null, null) })
    expect(reply).toMatchObject({ result: { kind: 'exact' } })
  })

  it('keeps the network it was sent, so a later job names it by key', () => {
    const answer = createTraceAnswerer()
    answer(request(1, 7, true))
    expect(answer(request(2, 7, false))).toMatchObject({ id: 2, result: { kind: 'exact' } })
  })

  it('says it was never sent a network it is asked for', () => {
    expect(createTraceAnswerer()(request(1, 3, false))).toEqual({ id: 1, missingNetwork: true })
  })

  it('keeps only the last four networks: the oldest has to be sent again', () => {
    const answer = createTraceAnswerer()
    for (const key of [1, 2, 3, 4, 5]) answer(request(key, key, true))
    expect(answer(request(10, 1, false))).toEqual({ id: 10, missingNetwork: true })
    expect(answer(request(11, 5, false))).toMatchObject({ id: 11, result: { kind: 'exact' } })
  })

  it('answers an error, not a crash, for a job it cannot trace', () => {
    const bad = { ...request(1, 1, true), job: { clearance: null } } as unknown as WorkerRequest
    expect(createTraceAnswerer()(bad)).toMatchObject({ id: 1, error: expect.any(String) })
  })
})
