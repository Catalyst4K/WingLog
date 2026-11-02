import { describe, expect, it } from 'vitest'
import type { GsxRemoteServiceDetail, GsxRemoteServiceStatus } from '@shared/ipc'
import {
  ENTRY_TIMEOUT_MS,
  NEW_GUARD,
  isServiceUnderWay,
  stepGuard,
  type GuardResult,
  type GuardSample,
  type GuardState
} from './data-entry-guard'

function service(id: string, state: string, detail?: GsxRemoteServiceDetail): GsxRemoteServiceStatus {
  return {
    id,
    displayName: id,
    state,
    stateText: '',
    icon: id.toLowerCase(),
    canTrigger: state === 'available',
    canBypass: false,
    statusText: '',
    progressText: '',
    detail
  }
}

/** Flight 256 (PMDG 777, VHHH): the fuel was 9,117 kg until the level was chosen, then 124,515 kg in one step; GSX's own detail
 *  said it was loading to 9,117 + 115,397 = 124,514 kg. The plan's ZFW was 202,857 kg. */
const FUEL_BEFORE_KG = 9_117
const FUEL_AFTER_KG = 124_515
const PLANNED_ZFW_KG = 202_857
const LOADING_777 = service('Refueling', 'performing', {
  fuel: { current: 91, target: 115_397, unit: 'kg', startTotal: 9_117, aircraftTotal: 124_514 }
})

/** Runs samples through the guard, one every `everyMs`, and returns the last result. */
function run(
  samples: (Partial<GuardSample> & { nowMs: number })[],
  base: Partial<GuardSample> = {},
  start: GuardState = NEW_GUARD
): GuardResult {
  let state = start
  let result: GuardResult | undefined
  for (const partial of samples) {
    result = stepGuard(state, {
      fuelTotalKg: FUEL_BEFORE_KG,
      totalWeightKg: FUEL_BEFORE_KG + PLANNED_ZFW_KG,
      refueling: undefined,
      boarding: undefined,
      plannedZfwKg: PLANNED_ZFW_KG,
      ...base,
      ...partial
    })
    state = result.state
  }
  if (!result) throw new Error('no samples')
  return result
}

const seconds = (s: number): number => s * 1000

describe('isServiceUnderWay', () => {
  it.each([
    ['requested', true],
    ['performing', true],
    ['completing', true],
    ['available', false],
    ['completed', false],
    ['bypassed', false]
  ])('%s is %s', (state, expected) => {
    expect(isServiceUnderWay(service('Refueling', state))).toBe(expected)
  })

  it('is false for a service GSX does not list', () => {
    expect(isServiceUnderWay(undefined)).toBe(false)
  })
})

describe('the fuel entry', () => {
  it('is closed when Refueling is not under way', () => {
    const result = run([{ nowMs: 0, refueling: service('Refueling', 'available') }])
    expect(result.fuelEntryOpen).toBe(false)
  })

  it('opens as soon as Refueling is requested', () => {
    const result = run([{ nowMs: 0, refueling: service('Refueling', 'requested') }])
    expect(result.fuelEntryOpen).toBe(true)
  })

  it('stays open through the minutes before the 777 refuelling level is chosen', () => {
    const waiting = Array.from({ length: 30 }, (_, i) => ({
      nowMs: seconds(i * 10),
      refueling: service('Refueling', 'performing')
    }))
    expect(run(waiting).fuelEntryOpen).toBe(true)
  })

  it('clears the 777 only once the jump has landed on GSX’s target and been steady for 5 s', () => {
    const base = { refueling: LOADING_777 }
    const before = [{ nowMs: 0 }, { nowMs: seconds(10) }, { nowMs: seconds(20) }]
    const justLanded = run([...before, { nowMs: seconds(30), fuelTotalKg: FUEL_AFTER_KG }], base)
    expect(justLanded.fuelEntryOpen).toBe(true)
    const steady = run(
      [
        ...before,
        { nowMs: seconds(30), fuelTotalKg: FUEL_AFTER_KG },
        { nowMs: seconds(33), fuelTotalKg: FUEL_AFTER_KG },
        { nowMs: seconds(36), fuelTotalKg: FUEL_AFTER_KG }
      ],
      base
    )
    expect(steady.fuelEntryOpen).toBe(false)
  })

  it('keeps a jump that misses GSX’s target closed, and says by how much', () => {
    const missed = 124_515 - 8_200
    const result = run(
      [
        { nowMs: 0 },
        { nowMs: seconds(10), fuelTotalKg: missed },
        { nowMs: seconds(20), fuelTotalKg: missed },
        { nowMs: seconds(30), fuelTotalKg: missed }
      ],
      { refueling: LOADING_777 }
    )
    expect(result.fuelEntryOpen).toBe(true)
    expect(result.fuelGapKg).toBe(8_199)
  })

  it('does not take a target in another unit as kilograms', () => {
    const inPounds = service('Refueling', 'performing', {
      fuel: { current: 0, target: 1, unit: 'lb', startTotal: 0, aircraftTotal: 1 }
    })
    const result = run(
      [
        { nowMs: 0 },
        { nowMs: seconds(10), fuelTotalKg: FUEL_AFTER_KG },
        { nowMs: seconds(20), fuelTotalKg: FUEL_AFTER_KG }
      ],
      { refueling: inPounds }
    )
    expect(result.fuelEntryOpen).toBe(false)
  })

  it('clears a progressive load (the Fenix) on a rise of more than 20 kg', () => {
    const base = { refueling: service('Refueling', 'performing') }
    expect(
      run([{ nowMs: 0 }, { nowMs: seconds(1), fuelTotalKg: FUEL_BEFORE_KG + 15 }], base).fuelEntryOpen
    ).toBe(true)
    expect(
      run([{ nowMs: 0 }, { nowMs: seconds(2), fuelTotalKg: FUEL_BEFORE_KG + 25 }], base).fuelEntryOpen
    ).toBe(false)
  })

  it('is not fooled by the APU burning fuel', () => {
    const result = run([{ nowMs: 0 }, { nowMs: seconds(10), fuelTotalKg: FUEL_BEFORE_KG - 40 }], {
      refueling: service('Refueling', 'performing')
    })
    expect(result.fuelEntryOpen).toBe(true)
  })

  it('clears when Refueling completes without the fuel rising', () => {
    const open = run([{ nowMs: 0, refueling: service('Refueling', 'requested') }])
    const done = stepGuard(open.state, {
      nowMs: seconds(5),
      fuelTotalKg: FUEL_BEFORE_KG,
      totalWeightKg: FUEL_BEFORE_KG + PLANNED_ZFW_KG,
      refueling: service('Refueling', 'completed'),
      boarding: undefined,
      plannedZfwKg: PLANNED_ZFW_KG
    })
    expect(done.fuelEntryOpen).toBe(false)
  })

  it('clears when Refueling is bypassed or cancelled', () => {
    for (const state of ['bypassed', 'available']) {
      const result = run(
        [{ nowMs: 0, refueling: service('Refueling', state) }],
        {},
        {
          fuel: { sinceMs: 0, baseKg: 1, previousKg: 1, jumpSeen: false, steadySinceMs: 0, done: null },
          payload: null
        }
      )
      expect(result.fuelEntryOpen).toBe(false)
      expect(result.state.fuel).toBeNull()
    }
  })

  it('gives up after 15 minutes and says so', () => {
    const base = { refueling: service('Refueling', 'performing') }
    const stillWaiting = run([{ nowMs: 0 }, { nowMs: ENTRY_TIMEOUT_MS - 1 }], base)
    expect(stillWaiting.fuelEntryOpen).toBe(true)
    expect(stillWaiting.timedOut).toBe(false)
    const timedOut = run([{ nowMs: 0 }, { nowMs: ENTRY_TIMEOUT_MS }], base)
    expect(timedOut.fuelEntryOpen).toBe(false)
    expect(timedOut.timedOut).toBe(true)
  })

  it('gives up on a jump that never reaches its target, too', () => {
    const result = run(
      [
        { nowMs: 0 },
        { nowMs: seconds(10), fuelTotalKg: 60_000 },
        { nowMs: ENTRY_TIMEOUT_MS + seconds(10), fuelTotalKg: 60_000 }
      ],
      { refueling: LOADING_777 }
    )
    expect(result.timedOut).toBe(true)
    expect(result.fuelEntryOpen).toBe(false)
  })

  it('does not reopen once done, even if the fuel then falls', () => {
    const base = { refueling: service('Refueling', 'performing') }
    const cleared = run([{ nowMs: 0 }, { nowMs: seconds(2), fuelTotalKg: FUEL_BEFORE_KG + 100 }], base)
    expect(cleared.fuelEntryOpen).toBe(false)
    const later = stepGuard(cleared.state, {
      nowMs: seconds(60),
      fuelTotalKg: FUEL_BEFORE_KG - 200,
      totalWeightKg: 0,
      refueling: base.refueling,
      boarding: undefined,
      plannedZfwKg: null
    })
    expect(later.fuelEntryOpen).toBe(false)
  })
})

describe('the payload entry', () => {
  const boarding = (done: number): GsxRemoteServiceStatus =>
    service('Boarding', 'performing', { pax: { done, total: 301 } })
  const weights = (zfw: number): Partial<GuardSample> => ({ totalWeightKg: FUEL_BEFORE_KG + zfw })

  it('is closed when Boarding is not under way', () => {
    expect(run([{ nowMs: 0, boarding: service('Boarding', 'available') }]).payloadEntryOpen).toBe(false)
  })

  it('opens as soon as Boarding is requested', () => {
    expect(run([{ nowMs: 0, boarding: service('Boarding', 'requested') }]).payloadEntryOpen).toBe(true)
  })

  it('stays open while the 777 payload is typed in field by field, downwards from a heavier earlier load', () => {
    const typed = [237_683, 236_993, 231_736, 217_626, 205_608]
    const result = run(
      typed.map((zfw, i) => ({ nowMs: seconds(i * 15), boarding: boarding(37), ...weights(zfw) }))
    )
    expect(result.payloadEntryOpen).toBe(true)
  })

  it('clears once the last field is within 50 kg of the plan and the ZFW has been steady for 5 s', () => {
    const series = [
      { nowMs: 0, ...weights(237_683) },
      { nowMs: seconds(15), ...weights(217_626) },
      { nowMs: seconds(30), ...weights(202_857) },
      { nowMs: seconds(33), ...weights(202_857) },
      { nowMs: seconds(36), ...weights(202_857) }
    ].map((s) => ({ ...s, boarding: boarding(37) }))
    expect(run(series.slice(0, 3)).payloadEntryOpen).toBe(true)
    expect(run(series).payloadEntryOpen).toBe(false)
  })

  it('holds while the ZFW is steady but nowhere near the plan', () => {
    const series = [0, 5, 10, 15].map((t) => ({
      nowMs: seconds(t),
      boarding: boarding(37),
      ...weights(237_683)
    }))
    series.push({ nowMs: seconds(20), boarding: boarding(37), ...weights(231_000) })
    series.push({ nowMs: seconds(30), boarding: boarding(37), ...weights(231_000) })
    expect(run(series).payloadEntryOpen).toBe(true)
  })

  it('holds until a passenger has boarded', () => {
    const series = [
      { nowMs: 0, boarding: boarding(0), ...weights(237_683) },
      { nowMs: seconds(10), boarding: boarding(0), ...weights(202_857) },
      { nowMs: seconds(20), boarding: boarding(0), ...weights(202_857) }
    ]
    expect(run(series).payloadEntryOpen).toBe(true)
  })

  it('holds when the ZFW has not changed since Boarding was requested', () => {
    const series = [0, 10, 20].map((t) => ({
      nowMs: seconds(t),
      boarding: boarding(5),
      ...weights(PLANNED_ZFW_KG)
    }))
    expect(run(series).payloadEntryOpen).toBe(true)
  })

  it('without a plan, clears on a steady ZFW that has changed with passengers on board', () => {
    const series = [
      { nowMs: 0, ...weights(237_683) },
      { nowMs: seconds(10), ...weights(202_000) },
      { nowMs: seconds(20), ...weights(202_000) }
    ].map((s) => ({ ...s, boarding: boarding(37), plannedZfwKg: null }))
    expect(run(series).payloadEntryOpen).toBe(false)
  })

  it('clears when Boarding completes', () => {
    const open = run([{ nowMs: 0, boarding: boarding(1) }])
    const done = stepGuard(open.state, {
      nowMs: seconds(60),
      fuelTotalKg: FUEL_BEFORE_KG,
      totalWeightKg: FUEL_BEFORE_KG + PLANNED_ZFW_KG,
      refueling: undefined,
      boarding: service('Boarding', 'completed'),
      plannedZfwKg: PLANNED_ZFW_KG
    })
    expect(done.payloadEntryOpen).toBe(false)
  })

  it('gives up after 15 minutes and says so', () => {
    const series = [
      { nowMs: 0, boarding: boarding(0), ...weights(237_683) },
      { nowMs: ENTRY_TIMEOUT_MS, boarding: boarding(0), ...weights(237_683) }
    ]
    const result = run(series)
    expect(result.payloadEntryOpen).toBe(false)
    expect(result.timedOut).toBe(true)
  })
})

describe('both directions', () => {
  it('holds Boarding for the fuel and Refueling for the payload independently', () => {
    const result = run([
      {
        nowMs: 0,
        refueling: service('Refueling', 'requested'),
        boarding: service('Boarding', 'requested')
      }
    ])
    expect(result.fuelEntryOpen).toBe(true)
    expect(result.payloadEntryOpen).toBe(true)
  })

  it('costs nothing when neither is under way', () => {
    const result = run([{ nowMs: 0 }])
    expect(result).toMatchObject({
      fuelEntryOpen: false,
      payloadEntryOpen: false,
      fuelGapKg: null,
      timedOut: false
    })
  })
})
