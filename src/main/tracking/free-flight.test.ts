import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { SimTelemetry } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { rememberAircraftForTitle } from '../db/settings-repo'
import { getFreeFlightPrefill, seedPhaseFromTelemetry } from './free-flight'

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

describe('seedPhaseFromTelemetry', () => {
  it('seeds preflight for a stationary aircraft on the ground', () => {
    expect(seedPhaseFromTelemetry(telemetry({ onGround: true, groundSpeedMs: 0 }))).toBe('preflight')
  })

  it('seeds taxi for a moving aircraft on the ground', () => {
    expect(seedPhaseFromTelemetry(telemetry({ onGround: true, groundSpeedMs: 5 }))).toBe('taxi')
  })

  it('seeds climb for an airborne aircraft with a positive vertical speed', () => {
    expect(seedPhaseFromTelemetry(telemetry({ onGround: false, verticalSpeedMs: 8 }))).toBe('climb')
  })

  it('seeds descent for an airborne aircraft with a negative vertical speed', () => {
    expect(seedPhaseFromTelemetry(telemetry({ onGround: false, verticalSpeedMs: -6 }))).toBe('descent')
  })

  it('seeds cruise for an airborne aircraft holding level', () => {
    expect(seedPhaseFromTelemetry(telemetry({ onGround: false, verticalSpeedMs: 0 }))).toBe('cruise')
  })

  it('treats ground movement right at the MOVING_MS boundary as still stationary', () => {
    expect(seedPhaseFromTelemetry(telemetry({ onGround: true, groundSpeedMs: 0.5 }))).toBe('preflight')
  })

  it('treats vertical speed right at the LEVEL_VS_MS boundary as still level', () => {
    expect(seedPhaseFromTelemetry(telemetry({ onGround: false, verticalSpeedMs: 0.5 }))).toBe('cruise')
    expect(seedPhaseFromTelemetry(telemetry({ onGround: false, verticalSpeedMs: -0.5 }))).toBe('cruise')
  })
})

describe('getFreeFlightPrefill', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  it('composes identity, a suggested departure from position, and no remembered aircraft for an unseen title', () => {
    const result = getFreeFlightPrefill(db, {
      atcId: 'F-WWTS',
      atcModel: 'A350-900',
      title: 'A350-900 (Default Cabin)',
      latitude: 51.4775,
      longitude: -0.4614 // real Heathrow coordinates
    })
    expect(result.registration).toBe('F-WWTS')
    expect(result.icaoType).toBe('A359')
    expect(result.icaoTypeAmbiguous).toBe(false)
    expect(result.suggestedDepIcao).toBe('EGLL')
    expect(result.rememberedAircraftId).toBeNull()
  })

  it('returns the remembered aircraft id for a title seen before', () => {
    rememberAircraftForTitle(db, 'FenixA320 IAE SL', 42)
    const result = getFreeFlightPrefill(db, {
      atcId: 'G-EUYY',
      atcModel: 'ATCCOM.AC_MODEL A320.0.text',
      title: 'FenixA320 IAE SL',
      latitude: 51.4775,
      longitude: -0.4614
    })
    expect(result.rememberedAircraftId).toBe(42)
  })

  it('leaves suggestedDepIcao null when nothing vendored is within range', () => {
    const result = getFreeFlightPrefill(db, {
      atcId: 'N12345',
      atcModel: 'C172',
      title: 'Cessna 172',
      latitude: 10,
      longitude: -160 // open Pacific
    })
    expect(result.suggestedDepIcao).toBeNull()
  })
})
