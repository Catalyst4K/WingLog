import { describe, expect, it } from 'vitest'
import type { SimTelemetry } from '@shared/ipc'
import type { RunwayEnd } from '../airports/runway-lookup'
import { buildLandingRecord } from './landing-capture'

function telemetry(overrides: Partial<SimTelemetry> = {}): SimTelemetry {
  return {
    latitude: 51.4775,
    longitude: -0.4614,
    altitudeM: 25,
    altitudeAglM: 0,
    verticalSpeedMs: -1.5,
    indicatedAirspeedMs: 70,
    trueAirspeedMs: 70,
    machSpeed: 0.11,
    groundSpeedMs: 65,
    headingTrueDeg: 270,
    pitchDeg: -2,
    bankDeg: 0,
    onGround: true,
    gForce: 1.3,
    fuelTotalKg: 10000,
    totalWeightKg: 70000,
    windSpeedMs: 8,
    windDirectionDeg: 270,
    engineCombustion1: true,
    gearHandlePosition: 1,
    flapsHandleIndex: 4,
    parkingBrakeOn: false,
    atcId: 'TEST',
    atcModel: 'A320',
    title: 'Test Aircraft',
    simRate: 1,
    slewActive: false,
    ...overrides
  }
}

const RUNWAY_27L: RunwayEnd = {
  icao: 'EGLL',
  ident: '27L',
  lat: 51.4775,
  lon: -0.4614,
  headingTrueDeg: 270,
  lengthM: null,
  widthM: null,
  displacedThresholdM: 0,
  elevationM: null,
  surface: null,
  aimingPointDistanceM: null
}
const resolveToRunway27L = (): RunwayEnd => RUNWAY_27L
const resolveToNoRunway = (): null => null

describe('buildLandingRecord', () => {
  it('always uses the ingested tick values, marked "derived"', () => {
    const record = buildLandingRecord(1, 'EGLL', telemetry(), '2026-09-01T12:00:00Z', resolveToRunway27L)
    expect(record.touchdownSource).toBe('derived')
    expect(record.verticalSpeedMs).toBe(-1.5)
    expect(record.pitchDeg).toBe(-2)
    expect(record.bankDeg).toBe(0)
  })

  it('computes headwind/crosswind and runway ident when a runway resolves', () => {
    const record = buildLandingRecord(
      1,
      'EGLL',
      telemetry({ windSpeedMs: 10, windDirectionDeg: 270 }),
      't',
      resolveToRunway27L
    )
    expect(record.runwayIdent).toBe('27L')
    expect(record.headwindMs).toBeCloseTo(10, 6)
    expect(record.crosswindMs).toBeCloseTo(0, 6)
  })

  it('computes crabDeg from the aircraft heading vs. the runway heading when a runway resolves', () => {
    const onHeading = buildLandingRecord(
      1,
      'EGLL',
      telemetry({ headingTrueDeg: 270 }),
      't',
      resolveToRunway27L
    )
    expect(onHeading.crabDeg).toBeCloseTo(0, 6)

    const crabbedRight = buildLandingRecord(
      1,
      'EGLL',
      telemetry({ headingTrueDeg: 278 }),
      't',
      resolveToRunway27L
    )
    expect(crabbedRight.crabDeg).toBeCloseTo(8, 6)

    const crabbedLeft = buildLandingRecord(
      1,
      'EGLL',
      telemetry({ headingTrueDeg: 262 }),
      't',
      resolveToRunway27L
    )
    expect(crabbedLeft.crabDeg).toBeCloseTo(-8, 6)
  })

  it('computes distanceFromThresholdM/centrelineOffsetM at the exact threshold position as ~zero', () => {
    const record = buildLandingRecord(1, 'EGLL', telemetry(), 't', resolveToRunway27L)
    expect(record.distanceFromThresholdM).toBeCloseTo(0, 0)
    expect(record.centrelineOffsetM).toBeCloseTo(0, 0)
  })

  it('reports distanceFromThresholdM from the real, displaced threshold — not the physical runway end', () => {
    // Touching down exactly at the physical end (0m along-track from runway-lookup.ts's
    // perspective) should read as -100m from a threshold displaced 100m inboard: the
    // aircraft is 100m short of where it's actually meant to land.
    const displaced: RunwayEnd = { ...RUNWAY_27L, displacedThresholdM: 100 }
    const record = buildLandingRecord(1, 'EGLL', telemetry(), 't', () => displaced)
    expect(record.distanceFromThresholdM).toBeCloseTo(-100, 0)
  })

  it('leaves every runway-derived field null when no runway resolves', () => {
    const record = buildLandingRecord(1, 'ZZZZ', telemetry(), 't', resolveToNoRunway)
    expect(record.runwayIdent).toBeNull()
    expect(record.headwindMs).toBeNull()
    expect(record.crosswindMs).toBeNull()
    expect(record.crabDeg).toBeNull()
    expect(record.distanceFromThresholdM).toBeNull()
    expect(record.centrelineOffsetM).toBeNull()
  })

  it('passes through the flap handle index as flapSetting', () => {
    const record = buildLandingRecord(1, 'EGLL', telemetry({ flapsHandleIndex: 3 }), 't', resolveToRunway27L)
    expect(record.flapSetting).toBe(3)
  })

  it('clamps an implausible G-force reading rather than storing it verbatim', () => {
    const tooHigh = buildLandingRecord(1, 'EGLL', telemetry({ gForce: 99 }), 't', resolveToRunway27L)
    expect(tooHigh.gForce).toBeLessThanOrEqual(6)
    const nan = buildLandingRecord(1, 'EGLL', telemetry({ gForce: NaN }), 't', resolveToRunway27L)
    expect(nan.gForce).toBe(1)
  })

  it('keeps a plausible G-force reading exactly as reported', () => {
    const record = buildLandingRecord(1, 'EGLL', telemetry({ gForce: 1.8 }), 't', resolveToRunway27L)
    expect(record.gForce).toBe(1.8)
  })
})
