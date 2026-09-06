import { describe, expect, it } from 'vitest'
import type { SimTelemetry } from '@shared/ipc'
import { FlightRecorder, type FlightRecorderResult } from './FlightRecorder'

const BASE_TIME = new Date('2026-09-01T12:00:00Z').getTime()
const at = (seconds: number): Date => new Date(BASE_TIME + seconds * 1000)

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

describe('FlightRecorder', () => {
  it('starts in preflight', () => {
    const recorder = new FlightRecorder(1)
    expect(recorder.getPhase()).toBe('preflight')
  })

  it('walks a full flight through every phase in order', () => {
    const recorder = new FlightRecorder(1)
    const seen: string[] = [recorder.getPhase()]
    let t = 0
    const step = (overrides: Partial<SimTelemetry>): void => {
      t += 1
      const result = recorder.ingest(telemetry(overrides), at(t))
      if (result.phase !== seen[seen.length - 1]) seen.push(result.phase)
    }

    // preflight -> pushback: engines start, still stationary
    step({ engineCombustion1: true, parkingBrakeOn: true })
    // pushback -> taxi: moving under own power
    step({ engineCombustion1: true, parkingBrakeOn: false, groundSpeedMs: 5 })
    // taxi -> takeoff: fast roll on the ground
    step({ engineCombustion1: true, groundSpeedMs: 40, indicatedAirspeedMs: 38 })
    // takeoff -> climb: airborne
    step({
      engineCombustion1: true,
      onGround: false,
      groundSpeedMs: 90,
      indicatedAirspeedMs: 85,
      verticalSpeedMs: 12,
      altitudeAglM: 50
    })
    // climb -> cruise: needs LEVEL_SUSTAIN_SAMPLES consecutive level samples
    for (let i = 0; i < 12; i++) {
      step({
        engineCombustion1: true,
        onGround: false,
        groundSpeedMs: 230,
        indicatedAirspeedMs: 250,
        verticalSpeedMs: 0.1,
        altitudeAglM: 10000,
        altitudeM: 10025
      })
    }
    // cruise -> descent: needs DESCENT_SUSTAIN_SAMPLES consecutive descending samples
    for (let i = 0; i < 7; i++) {
      step({
        engineCombustion1: true,
        onGround: false,
        groundSpeedMs: 200,
        indicatedAirspeedMs: 220,
        verticalSpeedMs: -3,
        altitudeAglM: 8000,
        altitudeM: 8025
      })
    }
    // descent -> landing: touchdown (on-ground false->true)
    step({
      engineCombustion1: true,
      onGround: true,
      groundSpeedMs: 65,
      verticalSpeedMs: -1.5,
      altitudeAglM: 0
    })
    // landing -> taxi: decelerated below roll speed
    step({ engineCombustion1: true, onGround: true, groundSpeedMs: 10 })
    // taxi -> shutdown: stopped, brake set, engines off
    step({ engineCombustion1: false, onGround: true, groundSpeedMs: 0, parkingBrakeOn: true })

    expect(seen).toEqual([
      'preflight',
      'pushback',
      'taxi',
      'takeoff',
      'climb',
      'cruise',
      'descent',
      'landing',
      'taxi',
      'shutdown'
    ])
  })

  it('emits a point on every tick outside cruise', () => {
    const recorder = new FlightRecorder(1)
    const r1 = recorder.ingest(telemetry({}), at(1))
    const r2 = recorder.ingest(telemetry({}), at(2))
    expect(r1.point).toBeDefined()
    expect(r2.point).toBeDefined()
  })

  it('downsamples to one point per ~5s during cruise', () => {
    const recorder = new FlightRecorder(1)
    // Drive it into cruise first.
    let t = 0
    const step = (overrides: Partial<SimTelemetry>): void => {
      t += 1
      recorder.ingest(telemetry(overrides), at(t))
    }
    step({ engineCombustion1: true })
    step({ engineCombustion1: true, groundSpeedMs: 5 })
    step({ engineCombustion1: true, groundSpeedMs: 40 })
    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12 })
    for (let i = 0; i < 12; i++) {
      step({ engineCombustion1: true, onGround: false, groundSpeedMs: 230, verticalSpeedMs: 0.1 })
    }
    expect(recorder.getPhase()).toBe('cruise')

    const cruisePoints: boolean[] = []
    for (let i = 0; i < 12; i++) {
      t += 1
      const result = recorder.ingest(
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 230 }),
        at(t)
      )
      cruisePoints.push(result.point !== undefined)
    }
    // First tick after entering cruise records immediately (no lastPointAt yet at the
    // new interval), then nothing until ~5s have elapsed.
    expect(cruisePoints.filter(Boolean).length).toBeLessThanOrEqual(3)
  })

  it('downsamples to one point per ~2s during climb', () => {
    const recorder = new FlightRecorder(1)
    let t = 0
    const step = (overrides: Partial<SimTelemetry>): void => {
      t += 1
      recorder.ingest(telemetry(overrides), at(t))
    }
    step({ engineCombustion1: true })
    step({ engineCombustion1: true, groundSpeedMs: 5 })
    step({ engineCombustion1: true, groundSpeedMs: 40 })
    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12 })
    expect(recorder.getPhase()).toBe('climb')

    const climbPoints: boolean[] = []
    for (let i = 0; i < 8; i++) {
      t += 1
      const result = recorder.ingest(
        telemetry({ engineCombustion1: true, onGround: false, groundSpeedMs: 200, verticalSpeedMs: 12 }),
        at(t)
      )
      climbPoints.push(result.point !== undefined)
    }
    // First tick after entering climb records immediately, then nothing until ~2s have
    // elapsed each time — roughly half the ticks, not every one.
    expect(climbPoints.filter(Boolean).length).toBeLessThan(climbPoints.length)
  })

  it('returns to cruise from descent on a sustained level-off, instead of getting stuck', () => {
    const recorder = new FlightRecorder(1)
    let t = 0
    const step = (overrides: Partial<SimTelemetry>): void => {
      t += 1
      recorder.ingest(telemetry(overrides), at(t))
    }
    step({ engineCombustion1: true })
    step({ engineCombustion1: true, groundSpeedMs: 5 })
    step({ engineCombustion1: true, groundSpeedMs: 40 })
    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12 })
    for (let i = 0; i < 12; i++) {
      step({ engineCombustion1: true, onGround: false, groundSpeedMs: 230, verticalSpeedMs: 0.1 })
    }
    expect(recorder.getPhase()).toBe('cruise')

    // A routine flight-level change: sustained descent long enough to (previously) commit
    // to "descent", then leveling off again well above the ground.
    for (let i = 0; i < 7; i++) {
      step({ engineCombustion1: true, onGround: false, groundSpeedMs: 220, verticalSpeedMs: -3 })
    }
    expect(recorder.getPhase()).toBe('descent')

    for (let i = 0; i < 10; i++) {
      step({ engineCombustion1: true, onGround: false, groundSpeedMs: 230, verticalSpeedMs: 0.1 })
    }
    expect(recorder.getPhase()).toBe('cruise')
  })

  it('ignores samples while slewing', () => {
    const recorder = new FlightRecorder(1)
    const result = recorder.ingest(
      telemetry({ slewActive: true, groundSpeedMs: 999, onGround: false }),
      at(1)
    )
    expect(result.phase).toBe('preflight')
    expect(result.point).toBeUndefined()
  })

  it('freezes phase and stops recording while paused', () => {
    const recorder = new FlightRecorder(1)
    recorder.ingest(telemetry({ engineCombustion1: true }), at(1))
    expect(recorder.getPhase()).toBe('pushback')

    recorder.setPaused(true)
    const result = recorder.ingest(
      telemetry({ engineCombustion1: true, groundSpeedMs: 40, onGround: false }),
      at(2)
    )
    expect(result.phase).toBe('pushback')
    expect(result.point).toBeUndefined()

    recorder.setPaused(false)
    const resumed = recorder.ingest(telemetry({ engineCombustion1: true, groundSpeedMs: 5 }), at(3))
    expect(resumed.phase).toBe('taxi')
  })

  it('stamps track points with the flight id and phase', () => {
    const recorder = new FlightRecorder(42)
    const result = recorder.ingest(telemetry({ latitude: 10, longitude: 20 }), at(1))
    expect(result.point).toMatchObject({ flightId: 42, phase: 'preflight', latitude: 10, longitude: 20 })
  })

  it('does not re-enter takeoff on a post-landing speed blip (reverse thrust, real 2026-09-05 flight)', () => {
    const recorder = new FlightRecorder(1)
    let t = 0
    const step = (overrides: Partial<SimTelemetry>): void => {
      t += 1
      recorder.ingest(telemetry(overrides), at(t))
    }

    // Same full walk as "walks a full flight through every phase in order" — reaching
    // 'landing' for real requires actually passing through climb/cruise/descent's sustain
    // windows, not just jumping onGround back to true from an earlier phase.
    step({ engineCombustion1: true, parkingBrakeOn: true }) // preflight -> pushback
    step({ engineCombustion1: true, parkingBrakeOn: false, groundSpeedMs: 5 }) // pushback -> taxi
    step({ engineCombustion1: true, groundSpeedMs: 40, indicatedAirspeedMs: 38 }) // taxi -> takeoff
    step({
      engineCombustion1: true,
      onGround: false,
      groundSpeedMs: 90,
      indicatedAirspeedMs: 85,
      verticalSpeedMs: 12,
      altitudeAglM: 50
    }) // takeoff -> climb
    for (let i = 0; i < 12; i++) {
      step({
        engineCombustion1: true,
        onGround: false,
        groundSpeedMs: 230,
        indicatedAirspeedMs: 250,
        verticalSpeedMs: 0.1,
        altitudeAglM: 10000,
        altitudeM: 10025
      }) // climb -> cruise
    }
    for (let i = 0; i < 7; i++) {
      step({
        engineCombustion1: true,
        onGround: false,
        groundSpeedMs: 200,
        indicatedAirspeedMs: 220,
        verticalSpeedMs: -3,
        altitudeAglM: 8000,
        altitudeM: 8025
      }) // cruise -> descent
    }
    step({ engineCombustion1: true, onGround: true, groundSpeedMs: 65, verticalSpeedMs: -1.5, altitudeAglM: 0 }) // descent -> landing
    expect(recorder.getPhase()).toBe('landing')

    step({ engineCombustion1: true, onGround: true, groundSpeedMs: 10 }) // landing -> taxi
    expect(recorder.getPhase()).toBe('taxi')

    // Reverse thrust / rollout speed noise: ground speed blips back above ROLL_SPEED_MS
    // while still decelerating to a stop, same shape as what previously re-triggered
    // 'takeoff' and left the flight permanently unable to reach 'shutdown'.
    step({ engineCombustion1: true, onGround: true, groundSpeedMs: 25 })
    expect(recorder.getPhase()).toBe('taxi')

    step({ engineCombustion1: false, onGround: true, groundSpeedMs: 0, parkingBrakeOn: true })
    expect(recorder.getPhase()).toBe('shutdown')
  })

  it('goes back to climb on a go-around from landing (rejected landing, never slowed below roll speed)', () => {
    const recorder = new FlightRecorder(1)
    let t = 0
    const step = (overrides: Partial<SimTelemetry>): void => {
      t += 1
      recorder.ingest(telemetry(overrides), at(t))
    }

    step({ engineCombustion1: true, parkingBrakeOn: true })
    step({ engineCombustion1: true, parkingBrakeOn: false, groundSpeedMs: 5 })
    step({ engineCombustion1: true, groundSpeedMs: 40, indicatedAirspeedMs: 38 })
    step({
      engineCombustion1: true,
      onGround: false,
      groundSpeedMs: 90,
      verticalSpeedMs: 12,
      altitudeAglM: 50
    })
    for (let i = 0; i < 12; i++) {
      step({ engineCombustion1: true, onGround: false, groundSpeedMs: 230, verticalSpeedMs: 0.1, altitudeAglM: 10000 })
    }
    for (let i = 0; i < 7; i++) {
      step({ engineCombustion1: true, onGround: false, groundSpeedMs: 200, verticalSpeedMs: -3, altitudeAglM: 8000 })
    }
    // Touches down, still fast (a bounce, or ATC/self go-around) — never drops below
    // ROLL_SPEED_MS before powering back up and lifting off again.
    step({ engineCombustion1: true, onGround: true, groundSpeedMs: 70, verticalSpeedMs: -1, altitudeAglM: 0 })
    expect(recorder.getPhase()).toBe('landing')

    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 8, altitudeAglM: 20 })
    expect(recorder.getPhase()).toBe('climb')
  })

  it('goes back to climb on a go-around from taxi (real second departure, not rollout noise)', () => {
    const recorder = new FlightRecorder(1)
    let t = 0
    const step = (overrides: Partial<SimTelemetry>): void => {
      t += 1
      recorder.ingest(telemetry(overrides), at(t))
    }

    step({ engineCombustion1: true, parkingBrakeOn: true })
    step({ engineCombustion1: true, parkingBrakeOn: false, groundSpeedMs: 5 })
    step({ engineCombustion1: true, groundSpeedMs: 40, indicatedAirspeedMs: 38 })
    step({
      engineCombustion1: true,
      onGround: false,
      groundSpeedMs: 90,
      verticalSpeedMs: 12,
      altitudeAglM: 50
    })
    for (let i = 0; i < 12; i++) {
      step({ engineCombustion1: true, onGround: false, groundSpeedMs: 230, verticalSpeedMs: 0.1, altitudeAglM: 10000 })
    }
    for (let i = 0; i < 7; i++) {
      step({ engineCombustion1: true, onGround: false, groundSpeedMs: 200, verticalSpeedMs: -3, altitudeAglM: 8000 })
    }
    step({ engineCombustion1: true, onGround: true, groundSpeedMs: 65, verticalSpeedMs: -1.5, altitudeAglM: 0 })
    step({ engineCombustion1: true, onGround: true, groundSpeedMs: 10 }) // landing -> taxi
    expect(recorder.getPhase()).toBe('taxi')

    // A real second takeoff roll from taxi, then genuinely airborne — distinct from the
    // reverse-thrust-blip test above, which never leaves the ground.
    step({ engineCombustion1: true, onGround: true, groundSpeedMs: 45 })
    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 10, altitudeAglM: 20 })
    expect(recorder.getPhase()).toBe('climb')
  })

  it('records taxi at ~3s intervals instead of every 1s tick', () => {
    const recorder = new FlightRecorder(1)
    let t = 0
    const step = (overrides: Partial<SimTelemetry>): FlightRecorderResult => {
      t += 1
      return recorder.ingest(telemetry(overrides), at(t))
    }
    step({ engineCombustion1: true })
    step({ engineCombustion1: true, groundSpeedMs: 5 })
    expect(recorder.getPhase()).toBe('taxi')

    const results: boolean[] = []
    for (let i = 0; i < 8; i++) {
      results.push(step({ engineCombustion1: true, groundSpeedMs: 5 }).point !== undefined)
    }
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(3)
  })

  it('records descent at ~5s intervals while well above the approach, then every tick once close to the ground', () => {
    const recorder = new FlightRecorder(1)
    let t = 0
    const step = (overrides: Partial<SimTelemetry>): FlightRecorderResult => {
      t += 1
      return recorder.ingest(telemetry(overrides), at(t))
    }
    step({ engineCombustion1: true })
    step({ engineCombustion1: true, groundSpeedMs: 5 })
    step({ engineCombustion1: true, groundSpeedMs: 40 })
    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12, altitudeAglM: 50 })
    for (let i = 0; i < 12; i++) {
      step({ engineCombustion1: true, onGround: false, groundSpeedMs: 230, verticalSpeedMs: 0.1, altitudeAglM: 10000 })
    }
    for (let i = 0; i < 7; i++) {
      step({ engineCombustion1: true, onGround: false, groundSpeedMs: 200, verticalSpeedMs: -3, altitudeAglM: 8000 })
    }
    expect(recorder.getPhase()).toBe('descent')

    const highAltitude: boolean[] = []
    for (let i = 0; i < 8; i++) {
      highAltitude.push(
        step({ engineCombustion1: true, onGround: false, groundSpeedMs: 200, verticalSpeedMs: -3, altitudeAglM: 5000 })
          .point !== undefined
      )
    }
    expect(highAltitude.filter(Boolean).length).toBeLessThanOrEqual(2)

    const onApproach: boolean[] = []
    for (let i = 0; i < 4; i++) {
      onApproach.push(
        step({ engineCombustion1: true, onGround: false, groundSpeedMs: 140, verticalSpeedMs: -2, altitudeAglM: 200 })
          .point !== undefined
      )
    }
    // Full 1 Hz once below DESCENT_APPROACH_AGL_M — every tick records.
    expect(onApproach.every(Boolean)).toBe(true)
  })
})
