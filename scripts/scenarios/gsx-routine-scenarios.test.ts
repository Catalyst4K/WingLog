/**
 * GSX routines against real recorded turnarounds (winglog-backend's docs/plans/gsx-service-presets.md, "Tests"): flight 256, the
 * PMDG 777-300ER that takes its whole fuel load in one step, and flight 242, the Fenix A320 whose own EFB asks for Boarding 6 s
 * after Catering completes. The production runner and guard are replayed over the recorded services and weights.
 */
import { describe, expect, it } from 'vitest'
import {
  stageRoutine,
  BUILT_IN_ROUTINES,
  type GsxRoutine,
  type GsxRoutineService
} from '../../src/shared/gsx-routines'
import { gsxRoutineFixture } from './bases'
import { guardClosedAt, replayRoutine, type RoutineFixture } from './gsx-routine-replay'

const FENIX_DEPARTURE = BUILT_IN_ROUTINES[0]

/** The plan's ZFW of flight 256, from the recorded weights once GSX had typed the payload in. */
const PLANNED_ZFW_777_KG = 202_857

const own = (services: GsxRoutineService[]): GsxRoutine => ({
  id: 'test',
  name: 'Test',
  stages: stageRoutine(services),
  answerGsxChoice: false,
  fuel: 'ask'
})

/**
 * @param fixture A recording.
 * @returns When the aircraft's fuel took its big step, in seconds from the start of the recording.
 */
function fuelStepAt(fixture: RoutineFixture): number {
  const rows = fixture.telemetry
  const index = rows.findIndex((row, i) => i > 0 && Math.abs(row[1] - rows[i - 1][1]) > 500)
  if (index < 0) throw new Error('the recording has no fuel step')
  return rows[index][0]
}

/**
 * @param fixture A recording.
 * @param id A service.
 * @param state A state.
 * @returns When the recording first shows the service in that state, in seconds from its start.
 */
function firstSeen(fixture: RoutineFixture, id: string, state: string): number {
  const change = fixture.services.find((c) => c.services.some((s) => s.id === id && s.state === state))
  if (!change) throw new Error(`${id} is never ${state}`)
  return change.t
}

describe('GSX routines against flight 256 (PMDG 777-300ER, VHHH)', () => {
  const fixture = gsxRoutineFixture(256)
  const fuelStep = fuelStepAt(fixture)

  it('takes the fuel step at the recorded 30.2 minutes, and Catering completes at 32.0', () => {
    expect((fuelStep + fixture.windowStartsAtS) / 60).toBeCloseTo(30.2, 0)
    expect((firstSeen(fixture, 'Catering', 'completed') + fixture.windowStartsAtS) / 60).toBeCloseTo(32.0, 1)
  })

  it('keeps the fuel entry open until the fuel step and the payload entry until the last field, as recorded', () => {
    const result = replayRoutine(fixture, {
      routine: own(['Refueling', 'Boarding']),
      startAtS: 20,
      plannedZfwKg: PLANNED_ZFW_777_KG,
      askedByRoutine: [],
      endAtS: 600
    })
    const fuelClosed = guardClosedAt(result, 'fuelEntryOpen')
    expect(fuelClosed).toBeGreaterThanOrEqual(fuelStep)
    expect(fuelClosed).toBeLessThanOrEqual(fuelStep + 15)
    // GSX typed the payload between 27.05 and 28.03 minutes (105 to 164 seconds into this slice), and its boarded count moved only at
    // 28.06 (184 s): the entry is done once the weight is steady and a passenger is counted.
    const payloadClosed = guardClosedAt(result, 'payloadEntryOpen')
    expect(payloadClosed).toBeGreaterThan(164)
    expect(payloadClosed).toBeLessThanOrEqual(190)
  })

  it('follows what the pilot asked for, and sees Catering complete when the recording does', () => {
    const result = replayRoutine(fixture, {
      routine: FENIX_DEPARTURE,
      startAtS: 30,
      plannedZfwKg: PLANNED_ZFW_777_KG,
      askedByRoutine: [],
      endAtS: 600
    })
    expect(result.completedAtS.Catering).toBeCloseTo(firstSeen(fixture, 'Catering', 'completed'), 0)
    expect(result.run.services.Catering?.progress).toBe('done')
    expect(result.pickedAtS).toEqual({})
  })

  it('under the Departure routine, asks for Boarding when Catering completes, long after the fuel step', () => {
    const result = replayRoutine(fixture, {
      routine: FENIX_DEPARTURE,
      startAtS: 24,
      plannedZfwKg: PLANNED_ZFW_777_KG,
      askedByRoutine: ['Catering', 'Refueling', 'Boarding'],
      endAtS: 700
    })
    const cateringDone = result.completedAtS.Catering
    expect(cateringDone).toBeDefined()
    expect(result.pickedAtS.Catering).toBeLessThan(30)
    expect(result.pickedAtS.Refueling).toBeLessThan(40)
    // Boarding is asked for as soon as Catering completes: the guard has been clear since the fuel step.
    expect(result.pickedAtS.Boarding).toBeGreaterThanOrEqual(cateringDone!)
    expect(result.pickedAtS.Boarding).toBeLessThanOrEqual(cateringDone! + 3)
    expect(result.pickedAtS.Boarding).toBeGreaterThan(fuelStep + 60)
    expect(guardClosedAt(result, 'fuelEntryOpen')).toBeLessThan(fuelStep + 15)
  })

  it('holds Boarding for the fuel step when nothing else holds it (Refueling then Boarding, not behind Catering)', () => {
    const result = replayRoutine(fixture, {
      routine: own(['Refueling', 'Boarding']),
      startAtS: 24,
      plannedZfwKg: PLANNED_ZFW_777_KG,
      askedByRoutine: ['Refueling', 'Boarding'],
      endAtS: 700
    })
    // The pilot asked for Boarding 67 s after Refueling and the data entries overlapped (the PMDG trouble). The routine waits.
    const asked = result.pickedAtS.Boarding
    expect(asked).toBeGreaterThanOrEqual(fuelStep)
    expect(asked).toBeLessThanOrEqual(fuelStep + 20)
    expect(asked! - result.pickedAtS.Refueling!).toBeGreaterThan(250)
    expect(result.events.some((e) => e.kind === 'note' && e.text === 'waiting-for-fuel-entry')).toBe(true)
  })

  it('holds Refueling while Boarding’s payload is being typed in', () => {
    const result = replayRoutine(fixture, {
      routine: own(['Refueling', 'Boarding']),
      startAtS: 90,
      plannedZfwKg: PLANNED_ZFW_777_KG,
      askedByRoutine: ['Refueling'],
      endAtS: 400
    })
    // Boarding is under way as recorded (asked at 93 s, payload typed until 164 s, counted at 184 s); the routine asks for Refueling after.
    const asked = result.pickedAtS.Refueling
    expect(asked).toBeGreaterThan(164)
    expect(asked).toBeLessThanOrEqual(195)
    expect(result.events.some((e) => e.kind === 'note' && e.text === 'waiting-for-payload-entry')).toBe(true)
  })

  it('stops, and does not ask for Boarding, when the flight has no planned weight', () => {
    const result = replayRoutine(fixture, {
      routine: FENIX_DEPARTURE,
      startAtS: 24,
      plannedZfwKg: null,
      askedByRoutine: ['Catering', 'Refueling', 'Boarding'],
      endAtS: 700
    })
    expect(result.run.outcome).toEqual({ state: 'stopped', reason: 'no-planned-weight' })
    expect(result.pickedAtS.Boarding).toBeUndefined()
  })
})

describe('GSX routines against flight 242 (Fenix A320, EGCC)', () => {
  const fixture = gsxRoutineFixture(242)

  it('asks for Boarding about when the Fenix EFB did: right after Catering completes', () => {
    const efbAsked = firstSeen(fixture, 'Boarding', 'requested') - firstSeen(fixture, 'Catering', 'completed')
    expect(efbAsked).toBeCloseTo(6, 0)

    const result = replayRoutine(fixture, {
      routine: FENIX_DEPARTURE,
      startAtS: 0,
      plannedZfwKg: 58_000,
      askedByRoutine: ['Catering', 'Refueling', 'Boarding'],
      endAtS: 700
    })
    const cateringDone = result.completedAtS.Catering!
    expect(result.pickedAtS.Boarding).toBeGreaterThanOrEqual(cateringDone)
    expect(result.pickedAtS.Boarding! - cateringDone).toBeLessThanOrEqual(efbAsked)
  })

  it('asks for Catering and Refueling one after another, in that routine’s order', () => {
    const result = replayRoutine(fixture, {
      routine: FENIX_DEPARTURE,
      startAtS: 0,
      plannedZfwKg: 58_000,
      askedByRoutine: ['Catering', 'Refueling', 'Boarding'],
      endAtS: 100
    })
    const order = result.events.filter((e) => e.kind === 'pick').map((e) => e.text)
    expect(order).toEqual(['asked GSX for Catering', 'asked GSX for Refueling'])
    expect(result.pickedAtS.Refueling! - result.pickedAtS.Catering!).toBeGreaterThanOrEqual(2)
  })

  it('does not hold Boarding for a progressive fuel load: its entry is done at the first 20 kg', () => {
    const result = replayRoutine(fixture, {
      routine: FENIX_DEPARTURE,
      startAtS: 0,
      plannedZfwKg: 58_000,
      askedByRoutine: ['Catering', 'Refueling', 'Boarding'],
      endAtS: 700
    })
    expect(result.events.some((e) => e.text === 'waiting-for-fuel-entry')).toBe(false)
    expect(guardClosedAt(result, 'fuelEntryOpen')).toBeLessThan(200)
  })
})
