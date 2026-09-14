import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { SimTelemetry } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight, getFlight, getInProgressFlight, listFlights } from '../db/flight-repo'
import { getLandingByFlight } from '../db/landing-repo'
import { createTrackPoint, listTrackPoints } from '../db/track-point-repo'
import type { SimConnectSource } from '../sim/SimConnectSource'
import { TrackingController } from './TrackingController'

function telemetry(overrides: Partial<SimTelemetry>): SimTelemetry {
  return {
    latitude: 51.4775,
    longitude: -0.4614,
    altitudeM: 25,
    pressureAltitudeM: 25,
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

/** A minimal SimConnectSource double: real EventEmitter plus a settable "last telemetry". */
function fakeSimConnectService(): EventEmitter &
  SimConnectSource & {
    setLastTelemetry: (t: SimTelemetry | undefined) => void
  } {
  const emitter = new EventEmitter() as EventEmitter &
    SimConnectSource & {
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

  it('auto-abandons a different stale flight with zero real progress, then starts the new one', () => {
    const aircraftId = createAircraft(db, { registration: 'G-WXYZ', icaoType: 'A320' }).id
    const otherFlightId = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC' }).id

    sim.setLastTelemetry(telemetry({}))
    const controller = new TrackingController(db, sim)
    controller.start(flightId) // still preflight: never took off, no points recorded

    controller.start(otherFlightId)

    expect(controller.getActive()).toEqual({ flightId: otherFlightId, phase: 'preflight' })
    expect(getFlight(db, flightId)?.status).toBe('active') // status untouched, per deleteFlight
    expect(getInProgressFlight(db)?.id).toBe(otherFlightId) // stale one no longer surfaces
    expect(getFlight(db, otherFlightId)?.status).toBe('active')
  })

  it('still refuses to start a different flight once the current one has recorded real track points', () => {
    const aircraftId = createAircraft(db, { registration: 'G-WXYZ', icaoType: 'A320' }).id
    const otherFlightId = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC' }).id

    sim.setLastTelemetry(telemetry({}))
    const controller = new TrackingController(db, sim)
    controller.start(flightId)
    sim.emit('telemetry', telemetry({})) // first tick always persists a track_point

    expect(() => controller.start(otherFlightId)).toThrow('Already tracking')
    expect(controller.getActive()).toEqual({ flightId, phase: 'preflight' })
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

  it('records the landing\'s verticalSpeedMs from the last airborne tick, not the touchdown tick', () => {
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
    // Last airborne tick, still descending hard...
    sim.emit(
      'telemetry',
      telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 65, verticalSpeedMs: -3.72 })
    )
    // ...then the touchdown tick itself, sink rate already bled off by gear compression —
    // matches the real flare-timing gap the flight-replay-harness fixed this to fix.
    sim.emit(
      'telemetry',
      telemetry({ engineCombustion1: true, onGround: true, groundSpeedMs: 60, verticalSpeedMs: -0.83 })
    )

    const landing = getLandingByFlight(db, flightId)
    expect(landing?.verticalSpeedMs).toBe(-3.72)
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

  it(
    'excludes a real in-session pause from the completed flight\'s block/air minutes ' +
      '(real case: pausing mid-cruise to test this exact thing inflated the logged time)',
    () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'))
      sim.setLastTelemetry(telemetry({}))
      const controller = new TrackingController(db, sim)
      controller.start(flightId)

      // preflight -> pushback -> taxi -> takeoff -> climb, each a real elapsed tick apart.
      vi.setSystemTime(new Date('2026-09-01T12:01:00.000Z'))
      sim.emit('telemetry', telemetry({ engineCombustion1: true }))
      vi.setSystemTime(new Date('2026-09-01T12:02:00.000Z'))
      sim.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 5 }))
      vi.setSystemTime(new Date('2026-09-01T12:03:00.000Z'))
      sim.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 40 }))
      vi.setSystemTime(new Date('2026-09-01T12:10:00.000Z'))
      sim.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12 })
      )
      expect(getFlight(db, flightId)?.actualOffUtc).toBe('2026-09-01T12:10:00.000Z')

      // A real 20-minute pause mid-cruise.
      vi.setSystemTime(new Date('2026-09-01T13:00:00.000Z'))
      sim.emit('paused', true)
      vi.setSystemTime(new Date('2026-09-01T13:20:00.000Z'))
      sim.emit('paused', false)

      // -> cruise -> descent -> landing (touchdown, actualOnUtc).
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
      vi.setSystemTime(new Date('2026-09-01T14:00:00.000Z'))
      sim.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: true, groundSpeedMs: 65, verticalSpeedMs: -1.5 })
      )
      expect(getFlight(db, flightId)?.actualOnUtc).toBe('2026-09-01T14:00:00.000Z')

      // -> taxi -> shutdown.
      sim.emit('telemetry', telemetry({ engineCombustion1: true, onGround: true, groundSpeedMs: 10 }))
      vi.setSystemTime(new Date('2026-09-01T14:05:00.000Z'))
      sim.emit(
        'telemetry',
        telemetry({ engineCombustion1: false, onGround: true, groundSpeedMs: 0, parkingBrakeOn: true })
      )

      const finished = getFlight(db, flightId)
      expect(finished?.status).toBe('completed')
      // Raw air time 12:10 -> 14:00 = 110 min, minus the 20-minute pause = 90.
      expect(finished?.airMinutes).toBe(90)
      vi.useRealTimers()
    }
  )

  it('deletes the flight on stop() rather than completing it or saving it as abandoned', () => {
    sim.setLastTelemetry(telemetry({}))
    const controller = new TrackingController(db, sim)
    controller.start(flightId)
    controller.stop()

    // getFlight is an internal FK-resolution lookup that still finds a tombstoned row
    // (flight-repo.test.ts's own deleteFlight tests rely on the same distinction) — every
    // user-facing list is what actually needs to come back empty.
    expect(listFlights(db)).toEqual([])
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

  // Crash recovery: the app quit or crashed before this flight reached 'completed' or
  // 'abandoned', leaving its row 'active' with no in-memory recorder to match — simulated
  // here with two separate TrackingController/SimConnectService pairs sharing the same db,
  // the second standing in for the fresh process after a restart.
  describe('resume', () => {
    it('does nothing for a flight that is not active', () => {
      const controller = new TrackingController(db, sim)
      controller.resume(flightId)
      expect(controller.getActive()).toBeUndefined()
    })

    it('picks phase detection back up from the last persisted track point, not preflight', () => {
      // Fake timers, with a real gap between ticks: resume() reads phase off the last
      // *persisted* track point, not the recorder's own live in-memory phase (which dies
      // with the process) — each downsampled phase needs a real elapsed interval behind it
      // to actually get written, same as a live flight recording at less than 1Hz.
      vi.useFakeTimers()
      const sim1 = fakeSimConnectService()
      sim1.setLastTelemetry(telemetry({}))
      const original = new TrackingController(db, sim1)
      original.start(flightId)

      sim1.emit('telemetry', telemetry({ engineCombustion1: true }))
      vi.advanceTimersByTime(2_000)
      sim1.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 5 }))
      vi.advanceTimersByTime(2_000)
      sim1.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 40 }))
      vi.advanceTimersByTime(2_000)
      sim1.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12 })
      )
      expect(original.getActive()?.phase).toBe('climb')
      expect(listTrackPoints(db, flightId).at(-1)?.phase).toBe('climb')

      // The old process is gone (neither stop() nor finish() ran, so the row stayed
      // 'active') — a fresh controller/sim pair stands in for the restarted app.
      const sim2 = fakeSimConnectService()
      const resumed = new TrackingController(db, sim2)
      resumed.resume(flightId)
      expect(resumed.getActive()).toEqual({ flightId, phase: 'climb' })

      // And it keeps advancing correctly from there — an aircraft that's actually
      // airborne isn't stuck waiting for an on-ground transition that will never come
      // (which is what starting fresh at 'preflight' would do).
      for (let i = 0; i < 12; i++) {
        sim2.emit(
          'telemetry',
          telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 230, verticalSpeedMs: 0.1 })
        )
      }
      expect(resumed.getActive()?.phase).toBe('cruise')
    })

    it('tags every point recorded after a resume with a new, incremented resumeSegment', () => {
      const sim1 = fakeSimConnectService()
      sim1.setLastTelemetry(telemetry({}))
      const original = new TrackingController(db, sim1)
      original.start(flightId)
      sim1.emit('telemetry', telemetry({ engineCombustion1: true }))
      expect(listTrackPoints(db, flightId).every((p) => p.resumeSegment === 0)).toBe(true)

      const sim2 = fakeSimConnectService()
      const resumed = new TrackingController(db, sim2)
      resumed.resume(flightId)
      sim2.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 5 }))

      const points = listTrackPoints(db, flightId)
      expect(points.slice(0, -1).every((p) => p.resumeSegment === 0)).toBe(true)
      expect(points.at(-1)?.resumeSegment).toBe(1)

      // A second resume in the same flight increments again, not just back to 1.
      const sim3 = fakeSimConnectService()
      const resumedAgain = new TrackingController(db, sim3)
      resumedAgain.resume(flightId)
      sim3.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 5 }))
      expect(listTrackPoints(db, flightId).at(-1)?.resumeSegment).toBe(2)
    })

    it('does not re-record off time or the fuel-out correction already locked in before the crash', () => {
      const sim1 = fakeSimConnectService()
      sim1.setLastTelemetry(telemetry({ fuelTotalKg: 9000 }))
      const original = new TrackingController(db, sim1)
      original.start(flightId)

      sim1.emit('telemetry', telemetry({ engineCombustion1: true, fuelTotalKg: 8500 }))
      sim1.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 5, fuelTotalKg: 8400 }))
      sim1.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 40, fuelTotalKg: 8300 }))
      sim1.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12, fuelTotalKg: 8200 })
      )
      const offAtCrash = getFlight(db, flightId)?.actualOffUtc
      const fuelOutAtCrash = getFlight(db, flightId)?.fuelOutKg
      expect(offAtCrash).toBeTruthy()
      expect(fuelOutAtCrash).toBe(8500) // locked in at the first past-preflight tick

      const sim2 = fakeSimConnectService()
      const resumed = new TrackingController(db, sim2)
      resumed.resume(flightId)
      sim2.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 200, verticalSpeedMs: 0.1, fuelTotalKg: 8000 })
      )

      expect(getFlight(db, flightId)?.actualOffUtc).toBe(offAtCrash)
      expect(getFlight(db, flightId)?.fuelOutKg).toBe(fuelOutAtCrash)
    })
  })

  // Phase 2 of flightdeck-backend's docs/plans/done/resume-track-cleanup.md — the actual
  // junk-exclusion pass, live-wired through checkForLiveJump/runTrackCleanup rather than
  // just the pure computeTrackCleanup function (resume-cleanup.test.ts covers that in
  // isolation).
  describe('resume-cleanup wiring', () => {
    it('excludes the spawn-then-fly-back junk live, as soon as a restore teleport resolves an open resume window', () => {
      vi.useFakeTimers()
      const sim1 = fakeSimConnectService()
      sim1.setLastTelemetry(telemetry({}))
      const original = new TrackingController(db, sim1)
      original.start(flightId)
      sim1.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 100, latitude: 51.4775, longitude: -0.4614 })
      )

      const sim2 = fakeSimConnectService()
      const resumed = new TrackingController(db, sim2)
      const updates: number[][] = []
      resumed.on('pointsUpdated', (points) => updates.push(points.map((p) => p.id)))
      resumed.resume(flightId)

      // Spawn point, far from the anchor — opens the resume window (Phase 1's boundary).
      vi.advanceTimersByTime(5_000)
      sim2.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 100, latitude: 52, longitude: 0 })
      )
      // The restore tool's teleport: instantly back near the anchor.
      vi.advanceTimersByTime(5_000)
      sim2.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 100, latitude: 51.4776, longitude: -0.4613 })
      )

      const points = listTrackPoints(db, flightId)
      const spawn = points.find((p) => p.resumeSegment === 1 && p.latitude === 52)
      expect(spawn?.excludedReason).toBe('resume-spurious')
      const reentry = points.find((p) => p.latitude === 51.4776)
      expect(reentry?.excludedReason).toBeNull()
      expect(updates.flat()).toEqual([spawn?.id])
    })

    it('retags the far side of a mid-flight teleport with a new segment, live, even with no resume window open', () => {
      vi.useFakeTimers()
      const sim = fakeSimConnectService()
      sim.setLastTelemetry(telemetry({}))
      const controller = new TrackingController(db, sim)
      controller.start(flightId)
      const updates: number[][] = []
      controller.on('pointsUpdated', (points) => updates.push(points.map((p) => p.id)))

      sim.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 100, latitude: 51.4775, longitude: -0.4614 })
      )
      vi.advanceTimersByTime(5_000)
      sim.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 100, latitude: 51.478, longitude: -0.462 })
      )
      // A payware aircraft's own save-state/reload feature teleports the aircraft — no
      // resume() anywhere near this, matching the real flight 193 iniBuilds A350 case
      // (resume-track-cleanup.md, "New real case found live, 2026-09-13").
      vi.advanceTimersByTime(5_000)
      sim.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 100, latitude: 10, longitude: 10 })
      )
      vi.advanceTimersByTime(5_000)
      sim.emit(
        'telemetry',
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 100, latitude: 10.001, longitude: 10.001 })
      )

      const points = listTrackPoints(db, flightId)
      expect(points.every((p) => p.excludedReason === null)).toBe(true)
      const teleportedSegment = points.find((p) => p.latitude === 10)?.resumeSegment
      expect(teleportedSegment).toBeDefined()
      expect(teleportedSegment).not.toBe(0)
      expect(points.find((p) => p.latitude === 10.001)?.resumeSegment).toBe(teleportedSegment)
      expect(points.find((p) => p.latitude === 51.478)?.resumeSegment).toBe(0)
      expect(updates.flat().length).toBeGreaterThan(0)
    })

    it('also runs as a backstop at flight completion, for a jump this process never live-observed', () => {
      // Seeded directly via createTrackPoint rather than telemetry ticks, so
      // checkForLiveJump never sees any of it — stands in for data this exact process
      // didn't record live (e.g. a plain restart of the recorder without going through
      // resume(), or a flight recorded before Phase 2 existed at all). finish()'s own
      // runTrackCleanup call is the only thing that can catch this.
      const sim = fakeSimConnectService()
      sim.setLastTelemetry(telemetry({}))
      const controller = new TrackingController(db, sim)
      controller.start(flightId)

      function seed(tsUtc: string, latitude: number, longitude: number): void {
        createTrackPoint(db, {
          flightId,
          tsUtc,
          latitude,
          longitude,
          altitudeM: 10000,
          pressureAltitudeM: null,
          altitudeAglM: 9900,
          indicatedAirspeedMs: 200,
          machSpeed: 0.6,
          groundSpeedMs: 200,
          verticalSpeedMs: 0,
          headingTrueDeg: 90,
          pitchDeg: 2,
          bankDeg: 0,
          phase: 'cruise',
          onGround: false,
          fuelKg: 8000,
          gForce: 1,
          windSpeedMs: 0,
          windDirectionDeg: 0,
          resumeSegment: 0,
          simRate: 1,
          excludedReason: null
        })
      }
      seed('2026-09-13T12:00:00.000Z', 0, 0)
      seed('2026-09-13T12:00:05.000Z', 20, 20)
      seed('2026-09-13T12:00:10.000Z', 20.001, 20.001)

      controller.finish()

      const points = listTrackPoints(db, flightId)
      expect(points.every((p) => p.excludedReason === null)).toBe(true)
      const teleportedSegment = points.find((p) => p.latitude === 20)?.resumeSegment
      expect(teleportedSegment).toBeDefined()
      expect(teleportedSegment).not.toBe(0)
      expect(points.find((p) => p.latitude === 20.001)?.resumeSegment).toBe(teleportedSegment)
      expect(points.find((p) => p.latitude === 0)?.resumeSegment).toBe(0)
    })
  })

  // Phase 5 (docs/plans/navdata-without-navigraph.md) — the renderer pushes live selection
  // updates that neither completion trigger below (finish() or shutdown detection) can ask
  // for directly, since neither round-trips through the renderer.
  describe('procedure selection persistence', () => {
    const selection = {
      departureRunway: '27R',
      sidIdent: 'BPK7F',
      sidTransition: 'CLEEE',
      starIdent: 'SIER7B',
      starTransition: null,
      approachIdent: 'ILS 07C',
      approachTransition: 'LIMES'
    }

    it('writes the last-pushed selection into the flight row on finish()', () => {
      sim.setLastTelemetry(telemetry({}))
      const controller = new TrackingController(db, sim)
      controller.start(flightId)
      controller.setProcedureSelection(selection)
      controller.finish()

      const finished = getFlight(db, flightId)
      expect(finished?.selectedDepartureRunway).toBe('27R')
      expect(finished?.selectedSidIdent).toBe('BPK7F')
      expect(finished?.selectedSidTransition).toBe('CLEEE')
      expect(finished?.selectedStarIdent).toBe('SIER7B')
      expect(finished?.selectedStarTransition).toBeNull()
      expect(finished?.selectedApproachIdent).toBe('ILS 07C')
      expect(finished?.selectedApproachTransition).toBe('LIMES')
    })

    it('writes the last-pushed selection at shutdown-detected completion too', () => {
      sim.setLastTelemetry(telemetry({}))
      const controller = new TrackingController(db, sim)
      controller.start(flightId)
      controller.setProcedureSelection(selection)

      sim.emit('telemetry', telemetry({ engineCombustion1: true }))
      sim.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 5 }))
      sim.emit('telemetry', telemetry({ engineCombustion1: true, groundSpeedMs: 40 }))
      sim.emit('telemetry', telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12 }))
      for (let i = 0; i < 12; i++) {
        sim.emit('telemetry', telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 230, verticalSpeedMs: 0.1 }))
      }
      for (let i = 0; i < 7; i++) {
        sim.emit('telemetry', telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 200, verticalSpeedMs: -3 }))
      }
      sim.emit('telemetry', telemetry({ engineCombustion1: true, onGround: true, groundSpeedMs: 65, verticalSpeedMs: -1.5 }))
      sim.emit('telemetry', telemetry({ engineCombustion1: true, onGround: true, groundSpeedMs: 10 }))
      sim.emit('telemetry', telemetry({ engineCombustion1: false, onGround: true, groundSpeedMs: 0, parkingBrakeOn: true }))

      expect(getFlight(db, flightId)?.selectedApproachIdent).toBe('ILS 07C')
    })

    it('leaves whatever createFlight already wrote alone when nothing was ever pushed', () => {
      const aircraftId = createAircraft(db, { registration: 'G-EFGH', icaoType: 'A320' }).id
      const plannedFlightId = createFlight(db, {
        aircraftId,
        depIcao: 'EGLL',
        arrIcao: 'VHHH',
        selectedSidIdent: 'PLANNED_SID'
      }).id
      sim.setLastTelemetry(telemetry({}))
      const controller = new TrackingController(db, sim)
      controller.start(plannedFlightId)
      controller.finish()

      expect(getFlight(db, plannedFlightId)?.selectedSidIdent).toBe('PLANNED_SID')
    })

    it('never leaks a selection pushed for one flight onto the next one tracked', () => {
      const aircraftId = createAircraft(db, { registration: 'G-EFGH', icaoType: 'A320' }).id
      const secondFlightId = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' }).id

      sim.setLastTelemetry(telemetry({}))
      const controller = new TrackingController(db, sim)
      controller.start(flightId)
      controller.setProcedureSelection(selection)
      controller.stop()

      controller.start(secondFlightId)
      controller.finish()

      expect(getFlight(db, secondFlightId)?.selectedApproachIdent).toBeNull()
    })
  })
})
