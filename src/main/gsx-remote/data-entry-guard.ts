/**
 * The data-entry guard (winglog-backend's docs/plans/gsx-service-presets.md, "The data-entry guard"): no routine requests
 * Boarding while Refueling's GSX data entry could still be running, or Refueling while Boarding's could. On the PMDG 777 GSX
 * types the fuel and the payload into the aircraft's backup MCDU, and two entries close together have mixed up before.
 *
 * A pure step function (coding-standards.md §10): GSX's services, the aircraft's weights and the clock go in, the new state
 * and whether each entry is still open come out. The fuel's target is GSX's own `detail.fuel` (`startTotal` + `target` is the
 * total the aircraft will hold, both in kg, read from flight 256's recording), not worked out from a menu label or the plan.
 */
import type { GsxRemoteServiceStatus } from '@shared/ipc'

/** The fuel has risen more than this since Refueling started: a progressive load (the Fenix) is under way. The APU only moves the total down. */
const FUEL_RISE_KG = 20
/** A change of more than this between two samples is a jump (the 777 takes its whole load in one step), not a progressive load. */
const FUEL_JUMP_KG = 500
/** A jump counts as landed when the aircraft is within this of the total GSX is loading to. */
const FUEL_TARGET_TOLERANCE_KG = 100
/** The payload counts as typed when the ZFW is within this of the plan's. */
const ZFW_TARGET_TOLERANCE_KG = 50
/** The ZFW has moved since Boarding was requested when it is this far from where it started. */
const ZFW_CHANGED_KG = 10
/** A weight is steady when it moved less than this since the last sample. */
const STEADY_KG = 10
/** A weight must be steady this long before an entry counts as done. */
const STEADY_MS = 5_000
/** Whichever entry is still not done after this is given up on, and the status says so. The 777's fuel step came about five minutes in. */
export const ENTRY_TIMEOUT_MS = 15 * 60_000

export interface FuelWatch {
  sinceMs: number
  /** The aircraft's fuel total when Refueling was first seen under way. */
  baseKg: number
  previousKg: number
  jumpSeen: boolean
  steadySinceMs: number
  done: 'loaded' | 'timeout' | null
}

export interface PayloadWatch {
  sinceMs: number
  baseZfwKg: number
  previousZfwKg: number
  steadySinceMs: number
  done: 'typed' | 'timeout' | null
}

export interface GuardState {
  fuel: FuelWatch | null
  payload: PayloadWatch | null
}

export const NEW_GUARD: GuardState = { fuel: null, payload: null }

export interface GuardSample {
  nowMs: number
  fuelTotalKg: number
  totalWeightKg: number
  refueling: GsxRemoteServiceStatus | undefined
  boarding: GsxRemoteServiceStatus | undefined
  /** The plan's zero fuel weight, or null when WingLog has none. */
  plannedZfwKg: number | null
}

export interface GuardResult {
  state: GuardState
  /** Boarding must not be requested yet. */
  fuelEntryOpen: boolean
  /** Refueling must not be requested yet. */
  payloadEntryOpen: boolean
  /** How far a fuel jump is from the total GSX is loading to, while it is off target. */
  fuelGapKg: number | null
  /** An entry was given up on because it timed out, for the status line. */
  timedOut: boolean
}

/**
 * @param service A GSX service.
 * @returns Whether the service is under way: asked for and not yet done (`completing` is the end of a load).
 */
export function isServiceUnderWay(service: GsxRemoteServiceStatus | undefined): boolean {
  return service?.state === 'requested' || service?.state === 'performing' || service?.state === 'completing'
}

/**
 * The total the aircraft will hold once GSX has loaded the fuel, from GSX's own detail. Present once the refuelling level has
 * been chosen, and only trusted in kilograms.
 *
 * @param refueling The Refueling service.
 * @returns The final fuel total in kg, or null while the level is not chosen.
 */
function targetFuelTotalKg(refueling: GsxRemoteServiceStatus): number | null {
  const fuel = refueling.detail?.fuel
  if (!fuel || fuel.unit !== 'kg' || !Number.isFinite(fuel.startTotal) || !Number.isFinite(fuel.target))
    return null
  return fuel.startTotal + fuel.target
}

/**
 * @param watch The watch before this sample.
 * @param sample The sample.
 * @param refueling The Refueling service, under way.
 * @returns The watch after this sample, and how far a jump is from its target.
 */
function stepFuel(
  watch: FuelWatch | null,
  sample: GuardSample,
  refueling: GsxRemoteServiceStatus
): { watch: FuelWatch; gapKg: number | null } {
  const { nowMs, fuelTotalKg } = sample
  if (!watch) {
    const fresh: FuelWatch = {
      sinceMs: nowMs,
      baseKg: fuelTotalKg,
      previousKg: fuelTotalKg,
      jumpSeen: false,
      steadySinceMs: nowMs,
      done: null
    }
    return { watch: fresh, gapKg: null }
  }
  if (watch.done) return { watch, gapKg: null }
  const moved = Math.abs(fuelTotalKg - watch.previousKg)
  const next: FuelWatch = {
    ...watch,
    previousKg: fuelTotalKg,
    jumpSeen: watch.jumpSeen || moved > FUEL_JUMP_KG,
    steadySinceMs: moved < STEADY_KG ? watch.steadySinceMs : nowMs
  }
  if (next.jumpSeen) {
    const target = targetFuelTotalKg(refueling)
    const gapKg = target === null ? 0 : Math.abs(fuelTotalKg - target)
    if (gapKg <= FUEL_TARGET_TOLERANCE_KG && nowMs - next.steadySinceMs >= STEADY_MS) next.done = 'loaded'
    else if (gapKg > FUEL_TARGET_TOLERANCE_KG) return withTimeout(next, nowMs, gapKg)
  } else if (fuelTotalKg - next.baseKg > FUEL_RISE_KG) {
    next.done = 'loaded'
  }
  return withTimeout(next, nowMs, null)
}

/**
 * @param watch The fuel watch.
 * @param nowMs The clock.
 * @param gapKg The gap to report.
 * @returns The watch, given up on if it has run out of time.
 */
function withTimeout(
  watch: FuelWatch,
  nowMs: number,
  gapKg: number | null
): { watch: FuelWatch; gapKg: number | null } {
  if (!watch.done && nowMs - watch.sinceMs >= ENTRY_TIMEOUT_MS)
    return { watch: { ...watch, done: 'timeout' }, gapKg }
  return { watch, gapKg }
}

/**
 * @param watch The payload watch before this sample.
 * @param sample The sample.
 * @param boarding The Boarding service, under way.
 * @returns The watch after this sample.
 */
function stepPayload(
  watch: PayloadWatch | null,
  sample: GuardSample,
  boarding: GsxRemoteServiceStatus
): PayloadWatch {
  const { nowMs, plannedZfwKg } = sample
  const zfwKg = sample.totalWeightKg - sample.fuelTotalKg
  if (!watch) {
    return { sinceMs: nowMs, baseZfwKg: zfwKg, previousZfwKg: zfwKg, steadySinceMs: nowMs, done: null }
  }
  if (watch.done) return watch
  const next: PayloadWatch = {
    ...watch,
    previousZfwKg: zfwKg,
    steadySinceMs: Math.abs(zfwKg - watch.previousZfwKg) < STEADY_KG ? watch.steadySinceMs : nowMs
  }
  const hasBoarded = (boarding.detail?.pax?.done ?? 0) > 0
  const hasChanged = Math.abs(zfwKg - next.baseZfwKg) > ZFW_CHANGED_KG
  const isOnPlan = plannedZfwKg === null || Math.abs(zfwKg - plannedZfwKg) <= ZFW_TARGET_TOLERANCE_KG
  if (hasBoarded && hasChanged && isOnPlan && nowMs - next.steadySinceMs >= STEADY_MS) next.done = 'typed'
  else if (nowMs - next.sinceMs >= ENTRY_TIMEOUT_MS) next.done = 'timeout'
  return next
}

/**
 * One step of the guard.
 *
 * @param state The guard so far.
 * @param sample GSX's services, the aircraft's weights, the plan's ZFW and the clock.
 * @returns The new state, and whether each entry is still open.
 */
export function stepGuard(state: GuardState, sample: GuardSample): GuardResult {
  let fuel: FuelWatch | null = null
  let gapKg: number | null = null
  if (sample.refueling && isServiceUnderWay(sample.refueling)) {
    const stepped = stepFuel(state.fuel, sample, sample.refueling)
    fuel = stepped.watch
    gapKg = stepped.gapKg
  }
  const payload =
    sample.boarding && isServiceUnderWay(sample.boarding)
      ? stepPayload(state.payload, sample, sample.boarding)
      : null
  return {
    state: { fuel, payload },
    fuelEntryOpen: fuel !== null && fuel.done === null,
    payloadEntryOpen: payload !== null && payload.done === null,
    fuelGapKg: gapKg !== null && gapKg > FUEL_TARGET_TOLERANCE_KG ? Math.round(gapKg) : null,
    timedOut: fuel?.done === 'timeout' || payload?.done === 'timeout'
  }
}
