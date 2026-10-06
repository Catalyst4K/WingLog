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

  it('records pressureAltitudeM straight from telemetry (logbook-detail-improvements.md, Phase 3)', () => {
    const recorder = new FlightRecorder(1)
    const result = recorder.ingest(telemetry({ altitudeM: 12000, pressureAltitudeM: 11850 }), at(1))
    expect(result.point).toMatchObject({ altitudeM: 12000, pressureAltitudeM: 11850 })
  })

  it('stamps every point with resumeSegment 0, the current sim rate, and no exclusion when never resumed', () => {
    const recorder = new FlightRecorder(1)
    const result = recorder.ingest(telemetry({ simRate: 4 }), at(1))
    expect(result.point).toMatchObject({ resumeSegment: 0, simRate: 4, excludedReason: null })
  })

  it('stamps every point with the resume segment passed at construction, once resumed', () => {
    const recorder = new FlightRecorder(1, { phase: 'cruise', hasLanded: false, resumeSegment: 2 })
    const result = recorder.ingest(telemetry({ onGround: false, groundSpeedMs: 230 }), at(1))
    expect(result.point).toMatchObject({ resumeSegment: 2 })
  })

  it('stamps every subsequent point with a new segment after bumpResumeSegment, without needing a resume()', () => {
    // Phase 2 of resume-track-cleanup.md — a live jump with no resume window open (e.g. a
    // payware aircraft's own save-state/reload feature) bumps this directly, not via the
    // resume constructor param.
    const recorder = new FlightRecorder(1)
    recorder.ingest(telemetry({}), at(1))
    recorder.bumpResumeSegment(5)
    const result = recorder.ingest(telemetry({}), at(3))
    expect(result.point).toMatchObject({ resumeSegment: 5 })
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

  it('never enters shutdown on its own with automatic finish switched off, and does once it is back on', () => {
    const recorder = new FlightRecorder(1, { phase: 'taxi', hasLanded: true, resumeSegment: 0 })
    recorder.setAutoShutdown(false)
    const parked = telemetry({ engineCombustion1: false, onGround: true, groundSpeedMs: 0, parkingBrakeOn: true })
    recorder.ingest(parked, at(1))
    recorder.ingest(parked, at(2))
    expect(recorder.getPhase()).toBe('taxi')

    recorder.setAutoShutdown(true)
    recorder.ingest(parked, at(3))
    expect(recorder.getPhase()).toBe('shutdown')
  })

  it('goes back to taxi on a rejected takeoff (aborted before ever leaving the ground)', () => {
    const recorder = new FlightRecorder(1)
    let t = 0
    const step = (overrides: Partial<SimTelemetry>): void => {
      t += 1
      recorder.ingest(telemetry(overrides), at(t))
    }

    step({ engineCombustion1: true, parkingBrakeOn: true })
    step({ engineCombustion1: true, parkingBrakeOn: false, groundSpeedMs: 5 })
    step({ engineCombustion1: true, groundSpeedMs: 40, indicatedAirspeedMs: 38 }) // taxi -> takeoff
    expect(recorder.getPhase()).toBe('takeoff')

    // Aborts before ever getting airborne: decelerates back below ROLL_SPEED_MS, still on
    // the ground the whole time — the real 2026-09-14 flight this bug was found on.
    step({ engineCombustion1: true, onGround: true, groundSpeedMs: 10 })
    expect(recorder.getPhase()).toBe('taxi')

    // A real second takeoff attempt afterward still works — hasLanded is still false, so
    // 'taxi' -> 'takeoff' -> 'climb' fires normally.
    step({ engineCombustion1: true, onGround: true, groundSpeedMs: 45 })
    expect(recorder.getPhase()).toBe('takeoff')
    step({
      engineCombustion1: true,
      onGround: false,
      groundSpeedMs: 90,
      verticalSpeedMs: 12,
      altitudeAglM: 20
    })
    expect(recorder.getPhase()).toBe('climb')
  })

  describe('takeoff only on a runway (flight 230, VHHH, 2026-10-05)', () => {
    // Real samples: a 35 kt taxi on the parallel taxiway (291 m off 25L) and the real roll on 07R.
    const TAXIWAY = { latitude: 22.30237804145619, longitude: 113.90856781667028 }
    const RUNWAY = { latitude: 22.296865859077617, longitude: 113.90006853800166 }
    const onRunway = (lat: number): boolean => Math.abs(lat - RUNWAY.latitude) < 0.0005

    function taxiing(check?: (lat: number, lon: number) => boolean | null): { recorder: FlightRecorder; step: (o: Partial<SimTelemetry>) => void } {
      const recorder = new FlightRecorder(1)
      if (check) recorder.setRunwayCheck(check)
      let t = 0
      const step = (overrides: Partial<SimTelemetry>): void => {
        t += 1
        recorder.ingest(telemetry({ engineCombustion1: true, parkingBrakeOn: false, ...overrides }), at(t))
      }
      step({ parkingBrakeOn: true })
      step({ groundSpeedMs: 5, ...TAXIWAY })
      return { recorder, step }
    }

    it('stays in taxi at 35 kt off the runway', () => {
      const { recorder, step } = taxiing((lat) => onRunway(lat))
      step({ groundSpeedMs: 18.3, ...TAXIWAY })
      step({ groundSpeedMs: 18.3, ...TAXIWAY })
      expect(recorder.getPhase()).toBe('taxi')
    })

    it('goes to takeoff on the runway', () => {
      const { recorder, step } = taxiing((lat) => onRunway(lat))
      step({ groundSpeedMs: 19.8, ...RUNWAY })
      expect(recorder.getPhase()).toBe('takeoff')
    })

    it('falls back to speed alone when it cannot tell', () => {
      const { recorder, step } = taxiing(() => null)
      step({ groundSpeedMs: 18.3, ...TAXIWAY })
      expect(recorder.getPhase()).toBe('takeoff')
    })

    it('still goes back to taxi on a rejected takeoff on the runway', () => {
      const { recorder, step } = taxiing((lat) => onRunway(lat))
      step({ groundSpeedMs: 30, ...RUNWAY })
      expect(recorder.getPhase()).toBe('takeoff')
      step({ groundSpeedMs: 10, ...RUNWAY })
      expect(recorder.getPhase()).toBe('taxi')
    })
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

    // Airborne for GO_AROUND_AIRBORNE_SAMPLES in a row — one tick alone is a bounce (below).
    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 90, verticalSpeedMs: 8, altitudeAglM: 20 })
    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 92, verticalSpeedMs: 8, altitudeAglM: 40 })
    expect(recorder.getPhase()).toBe('landing')
    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 94, verticalSpeedMs: 8, altitudeAglM: 60 })
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
    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 92, verticalSpeedMs: 10, altitudeAglM: 40 })
    step({ engineCombustion1: true, onGround: false, groundSpeedMs: 94, verticalSpeedMs: 10, altitudeAglM: 60 })
    expect(recorder.getPhase()).toBe('climb')
  })

  describe('bounces and missed landings (flights 227 and 198)', () => {
    /** Departs, levels off, starts down: the recorder is in 'descent' on return. */
    function flyToDescent(): { recorder: FlightRecorder; step: (o: Partial<SimTelemetry>) => FlightRecorderResult } {
      const recorder = new FlightRecorder(1)
      let t = 0
      const step = (overrides: Partial<SimTelemetry>): FlightRecorderResult => {
        t += 1
        return recorder.ingest(telemetry({ engineCombustion1: true, parkingBrakeOn: false, ...overrides }), at(t))
      }
      step({ parkingBrakeOn: true })
      step({ groundSpeedMs: 5 })
      step({ groundSpeedMs: 40, indicatedAirspeedMs: 38 })
      step({ onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12, altitudeAglM: 50 })
      for (let i = 0; i < 12; i++) step({ onGround: false, groundSpeedMs: 230, verticalSpeedMs: 0.1, altitudeAglM: 10000 })
      for (let i = 0; i < 7; i++) step({ onGround: false, groundSpeedMs: 200, verticalSpeedMs: -3, altitudeAglM: 8000 })
      expect(recorder.getPhase()).toBe('descent')
      return { recorder, step }
    }

    it('rides out a one-tick bounce on the rollout and reaches taxi and shutdown (flight 227, VHHH 2026-10-02)', () => {
      const { recorder, step } = flyToDescent()
      // Flight 227's real touchdown: 67.6 m/s on the ground, one airborne tick, then a
      // rollout through ten-plus "level" samples that used to read as climb -> cruise.
      step({ onGround: true, groundSpeedMs: 67.6, verticalSpeedMs: -1.48, altitudeAglM: 3.5 })
      expect(recorder.getPhase()).toBe('landing')
      step({ onGround: false, groundSpeedMs: 66.2, verticalSpeedMs: -0.35, altitudeAglM: 3.9 })
      expect(recorder.getPhase()).toBe('landing')
      const phases = new Set<string>()
      for (const groundSpeedMs of [64.8, 60.7, 54.8, 45.9, 38.2, 30.9, 25.4, 19.6, 13.1, 8.9]) {
        phases.add(step({ onGround: true, groundSpeedMs, verticalSpeedMs: 0.01, altitudeAglM: 2.8 }).phase)
      }
      expect([...phases]).toEqual(['landing', 'taxi'])

      step({ groundSpeedMs: 0, parkingBrakeOn: true, engineCombustion1: false })
      expect(recorder.getPhase()).toBe('shutdown')
    })

    it('comes back down from a longer bounce that did count as a go-around', () => {
      const { recorder, step } = flyToDescent()
      step({ onGround: true, groundSpeedMs: 68, verticalSpeedMs: -1.5 })
      for (let i = 0; i < 3; i++) step({ onGround: false, groundSpeedMs: 67, verticalSpeedMs: 0.3, altitudeAglM: 3 })
      expect(recorder.getPhase()).toBe('climb')

      step({ onGround: true, groundSpeedMs: 62 })
      step({ onGround: true, groundSpeedMs: 58 })
      expect(recorder.getPhase()).toBe('climb')
      step({ onGround: true, groundSpeedMs: 54 })
      expect(recorder.getPhase()).toBe('landing')
      step({ onGround: true, groundSpeedMs: 10 })
      expect(recorder.getPhase()).toBe('taxi')
      // Counted as landed: a rollout speed blip can't start a second takeoff roll.
      step({ onGround: true, groundSpeedMs: 25 })
      expect(recorder.getPhase()).toBe('taxi')
    })

    it('lands a circuit that touches down straight from climb, without ever reaching descent (flight 198, VHHH)', () => {
      const recorder = new FlightRecorder(1)
      let t = 0
      const step = (overrides: Partial<SimTelemetry>): void => {
        t += 1
        recorder.ingest(telemetry({ engineCombustion1: true, parkingBrakeOn: false, ...overrides }), at(t))
      }
      step({ parkingBrakeOn: true })
      step({ groundSpeedMs: 5 })
      step({ groundSpeedMs: 40, indicatedAirspeedMs: 38 })
      step({ onGround: false, groundSpeedMs: 90, verticalSpeedMs: 12, altitudeAglM: 50 })
      step({ onGround: false, groundSpeedMs: 70, verticalSpeedMs: -4, altitudeAglM: 200 })
      step({ onGround: false, groundSpeedMs: 65, verticalSpeedMs: -3, altitudeAglM: 30 })
      expect(recorder.getPhase()).toBe('climb')

      for (const groundSpeedMs of [60, 50, 40]) step({ onGround: true, groundSpeedMs })
      expect(recorder.getPhase()).toBe('landing')
      step({ onGround: true, groundSpeedMs: 8 })
      expect(recorder.getPhase()).toBe('taxi')
    })

    it('stays in climb when the wheels touch once just after liftoff', () => {
      const recorder = new FlightRecorder(1)
      let t = 0
      const step = (overrides: Partial<SimTelemetry>): void => {
        t += 1
        recorder.ingest(telemetry({ engineCombustion1: true, parkingBrakeOn: false, ...overrides }), at(t))
      }
      step({ parkingBrakeOn: true })
      step({ groundSpeedMs: 5 })
      step({ groundSpeedMs: 40, indicatedAirspeedMs: 38 })
      step({ onGround: false, groundSpeedMs: 75, verticalSpeedMs: 2, altitudeAglM: 1 })
      step({ onGround: true, groundSpeedMs: 77, verticalSpeedMs: 0, altitudeAglM: 0 })
      step({ onGround: false, groundSpeedMs: 80, verticalSpeedMs: 8, altitudeAglM: 10 })
      expect(recorder.getPhase()).toBe('climb')
    })

    it('recovers a flight resumed in cruise while already on the ground after landing', () => {
      const recorder = new FlightRecorder(1, { phase: 'cruise', hasLanded: true, resumeSegment: 1 })
      let t = 0
      const step = (overrides: Partial<SimTelemetry>): void => {
        t += 1
        recorder.ingest(telemetry({ engineCombustion1: true, parkingBrakeOn: false, ...overrides }), at(t))
      }
      for (let i = 0; i < 3; i++) step({ onGround: true, groundSpeedMs: 9 })
      expect(recorder.getPhase()).toBe('landing')
      step({ onGround: true, groundSpeedMs: 9 })
      expect(recorder.getPhase()).toBe('taxi')
    })
  })

  // Was every ~3s until 2026-10, which drew taxi turns as 20-60m chords across the fillet
  // (winglog-backend's ground-track-resolution.md).
  it('records taxi on every 1s tick, like the other ground phases', () => {
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
    expect(results.every(Boolean)).toBe(true)
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
