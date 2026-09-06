import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { SimTelemetry } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight, getFlight } from '../db/flight-repo'
import { listTrackPoints } from '../db/track-point-repo'
import type { SimConnectService } from '../sim/SimConnectService'
import { TrackingController } from './TrackingController'

function telemetry(overrides: Partial<SimTelemetry>): SimTelemetry {
  return {
    latitude: 51.4775,
    longitude: -0.4614,
    altitudeM: 25,
    altitudeAglM: 0,
    verticalSpeedMs: 0,
    indicatedAirspeedMs: 0,
    trueAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    onGround: true,
    gForce: 1,
    fuelTotalKg: 10000,
    totalWeightKg: 70000,
    windSpeedMs: 3,
    windDirectionDeg: 250,
    engineCombustion1: false,
    gearHandlePosition: 1,
    flapsHandleIndex: 0,
    parkingBrakeOn: true,
    atcId: 'TEST',
    atcModel: 'A320',
    title: 'Test Aircraft',
    simRate: 1,
    slewActive: false,
    ...overrides
  }
}

/** A minimal SimConnectService double: real EventEmitter plus a settable "last telemetry". */
function fakeSimConnectService(): SimConnectService & {
  setLastTelemetry: (t: SimTelemetry | undefined) => void
} {
  const emitter = new EventEmitter() as unknown as SimConnectService & {
    setLastTelemetry: (t: SimTelemetry | undefined) => void
  }
  let last: SimTelemetry | undefined
  emitter.getLastTelemetry = () => last
  emitter.setLastTelemetry = (t) => {
    last = t
  }
  return emitter
}

describe('TrackingController', () => {
  let db: WingLogDb
  let sim: ReturnType<typeof fakeSimConnectService>
  let flightId: number

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    sim = fakeSimConnectService()
    const aircraftId = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' }).id
    flightId = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' }).id
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses to start without a live telemetry sample', () => {
    const controller = new TrackingController(db, sim)
    expect(() => controller.start(flightId)).toThrow('Not connected')
  })

  it('refuses to start tracking a nonexistent flight', () => {
    sim.setLastTelemetry(telemetry({}))
    const controller = new TrackingController(db, sim)
    expect(() => controller.start(99999)).toThrow('not found')
  })

  it('marks the flight active and snapshots fuel on start', () => {
    sim.setLastTelemetry(telemetry({ fuelTotalKg: 12345 }))
    const controller = new TrackingController(db, sim)
    controller.start(flightId)

    const flight = getFlight(db, flightId)
    expect(flight?.status).toBe('active')
    expect(flight?.fuelOutKg).toBe(12345)
    expect(controller.getActive()).toEqual({ flightId, phase: 'preflight' })
  })

  it('refuses to start a second flight while one is already being tracked', () => {
    sim.setLastTelemetry(telemetry({}))
    const controller = new TrackingController(db, sim)
    controller.start(flightId)
    expect(() => controller.start(flightId)).toThrow('Already tracking')
  })

  it('persists points and emits them as telemetry streams in', () => {
    vi.useFakeTimers()
    sim.setLastTelemetry(telemetry({}))
    const controller = new TrackingController(db, sim)
    controller.start(flightId)

    const emitted: number[] = []
    controller.on('point', (p) => emitted.push(p.id))

    sim.emit('telemetry', telemetry({}))
    vi.advanceTimersByTime(1_000)
    sim.emit('telemetry', telemetry({}))

    expect(emitted).toHaveLength(2)
    expect(listTrackPoints(db, flightId)).toHaveLength(2)
  })

  it('records off/on/completion and stops tracking at shutdown', () => {
    sim.setLastTelemetry(telemetry({}))
    const controller = new TrackingController(db, sim)
    controller.start(flightId)

    sim.emit('telemetry', telemetry({ engineCombustion1: true }))
    sim.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 5 }))
    sim.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 40 }))
    sim.emit(
      'telemetry',
      telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12 })
    )
    expect(getFlight(db, flightId)?.actualOffUtc).toBeTruthy()

    for (let i = 0; i < 12; i++) {
      sim.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 230, verticalSpeedMs: 0.1 })
      )
    }
    for (let i = 0; i < 7; i++) {
      sim.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 200, verticalSpeedMs: -3 })
      )
    }
    sim.emit(
      'telemetry',
      telemetry({ engineCombustion1: true, onGround: true, groundSpeedMs: 65, verticalSpeedMs: -1.5 })
    )
    expect(getFlight(db, flightId)?.actualOnUtc).toBeTruthy()

    sim.emit('telemetry', telemetry({ engineCombustion1: true, onGround: true, groundSpeedMs: 10 }))
    sim.emit(
      'telemetry',
      telemetry({ engineCombustion1: false, onGround: true, groundSpeedMs: 0, parkingBrakeOn: true })
    )

    const finished = getFlight(db, flightId)
    expect(finished?.status).toBe('completed')
    expect(controller.getActive()).toBeUndefined()
  })

  it('freezes recording while the sim reports paused', () => {
    sim.setLastTelemetry(telemetry({}))
    const controller = new TrackingController(db, sim)
    controller.start(flightId)

    sim.emit('paused', true)
    sim.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 40, onGround: false }))
    expect(controller.getActive()?.phase).toBe('preflight')

    sim.emit('paused', false)
    sim.emit('telemetry', telemetry({ engineCombustion1: true }))
    expect(controller.getActive()?.phase).toBe('pushback')
  })

  it('abandons the flight on stop() rather than completing it', () => {
    sim.setLastTelemetry(telemetry({}))
    const controller = new TrackingController(db, sim)
    controller.start(flightId)
    controller.stop()

    expect(getFlight(db, flightId)?.status).toBe('abandoned')
    expect(controller.getActive()).toBeUndefined()
  })

  it('completes the flight on finish() using the last known fuel figure, without waiting for shutdown', () => {
    sim.setLastTelemetry(telemetry({ fuelTotalKg: 9000 }))
    const controller = new TrackingController(db, sim)
    controller.start(flightId)

    sim.setLastTelemetry(telemetry({ fuelTotalKg: 4000 }))
    controller.finish()

    const finished = getFlight(db, flightId)
    expect(finished?.status).toBe('completed')
    expect(finished?.fuelInKg).toBe(4000)
    expect(controller.getActive()).toBeUndefined()
  })

  it('corrects fuel_out_kg to the reading at the first ground-movement/engine-start tick, not the tracking-start snapshot', () => {
    // Mirrors a real case (flight-test-findings-2026-09-06.md #3): the value captured at
    // the instant tracking starts can be stale post-reload telemetry or simply "before
    // ground fuel service finished" — this correction is what fixes both.
    sim.setLastTelemetry(telemetry({ fuelTotalKg: 10187 }))
    const controller = new TrackingController(db, sim)
    controller.start(flightId)
    expect(getFlight(db, flightId)?.fuelOutKg).toBe(10187)

    // Still sitting at the gate (refuel in progress) — not yet pushback/engine-start, so
    // no correction should happen on this tick.
    sim.emit('telemetry', telemetry({ fuelTotalKg: 6504 }))
    expect(getFlight(db, flightId)?.fuelOutKg).toBe(10187)

    // Engine start — the first real "past ground service" signal.
    sim.emit('telemetry', telemetry({ fuelTotalKg: 6504, engineCombustion1: true }))
    expect(getFlight(db, flightId)?.fuelOutKg).toBe(6504)

    // A later tick's fuel figure (normal burn during pushback/taxi) must not overwrite
    // the one already locked in — only the first post-preflight tick counts.
    sim.emit('telemetry', telemetry({ fuelTotalKg: 6490, engineCombustion1: true, groundSpeedMs: 5 }))
    expect(getFlight(db, flightId)?.fuelOutKg).toBe(6504)
  })

  it('finish() is a no-op when nothing is being tracked', () => {
    const controller = new TrackingController(db, sim)
    expect(() => controller.finish()).not.toThrow()
    expect(getFlight(db, flightId)?.status).toBe('planned')
  })
})
