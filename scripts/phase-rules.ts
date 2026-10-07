/**
 * Rule-based tests for the phase machine (winglog-backend docs/plans/robustness/scenario-testing.md Part 5): seeded, reproducible
 * flights built from real-shaped pieces (taxi, roll, rotate, climb, level-off, descent, flare, bounce, rollout...) with random
 * speeds, durations and noise, run through `stepPhase`, and checked against rules that must hold whatever the flight did. A failure
 * prints the seed and the flight's pieces, so it can be replayed and shrunk by hand.
 */
import type { FlightPhase, SimTelemetry } from '@shared/ipc'
import {
  INITIAL_PHASE_STATE,
  stepPhase,
  type PhaseSettings,
  type PhaseState
} from '../src/main/tracking/flight-phase-step'

/** A tiny seeded generator (mulberry32), so a failing seed replays exactly. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One second of the flight, and whether the aircraft is on the runway strip. */
export interface Tick {
  t: SimTelemetry
  onRunway: boolean
}

/** Latitude of the runway strip; the taxiways are a few hundred metres off it. */
const RUNWAY_LAT = 51.47
const TAXIWAY_LAT = 51.4735

/** The kinds of piece a flight is made of. */
export type PieceKind =
  | 'parked'
  | 'pushback'
  | 'taxi'
  | 'fastTaxi'
  | 'lineUpRoll'
  | 'rotate'
  | 'climb'
  | 'level'
  | 'descent'
  | 'touchdown'
  | 'bounce'
  | 'rollout'
  | 'rolloutBlip'
  | 'taxiIn'
  | 'park'
  | 'rejectedTakeoff'
  | 'goAround'

/** The flight's recipe: the pieces in order. */
export type Recipe = PieceKind[]

function telemetry(o: Partial<SimTelemetry>): SimTelemetry {
  return {
    latitude: TAXIWAY_LAT,
    longitude: -0.45,
    altitudeM: 25,
    pressureAltitudeM: 25,
    altitudeAglM: 0,
    verticalSpeedMs: 0,
    indicatedAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    onGround: true,
    gForce: 1,
    fuelTotalKg: 5000,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    engineCombustion1: true,
    parkingBrakeOn: false,
    simRate: 1,
    slewActive: false,
    ...o
  } as SimTelemetry
}

/**
 * @param rand The generator.
 * @param lo Lowest value.
 * @param hi Highest value.
 * @returns A number in [lo, hi).
 */
function between(rand: () => number, lo: number, hi: number): number {
  return lo + rand() * (hi - lo)
}

/**
 * The ticks of one piece. Each is a few seconds to a few minutes of real-shaped telemetry with noise.
 *
 * @param kind The piece.
 * @param rand The generator.
 * @returns Its ticks, one per second.
 */
export function pieceTicks(kind: PieceKind, rand: () => number): Tick[] {
  const n = (lo: number, hi: number): number => Math.floor(between(rand, lo, hi))
  const ground = (speed: number, o: Partial<SimTelemetry> = {}, onRunway = false): Tick => ({
    t: telemetry({
      groundSpeedMs: Math.max(0, speed + between(rand, -0.3, 0.3)),
      latitude: onRunway ? RUNWAY_LAT : TAXIWAY_LAT,
      ...o
    }),
    onRunway
  })
  const air = (vs: number, speed: number, agl: number, o: Partial<SimTelemetry> = {}): Tick => ({
    t: telemetry({
      onGround: false,
      verticalSpeedMs: vs + between(rand, -0.15, 0.15),
      groundSpeedMs: speed,
      altitudeAglM: agl,
      latitude: RUNWAY_LAT,
      ...o
    }),
    onRunway: true
  })
  switch (kind) {
    case 'parked':
      return Array.from({ length: n(3, 20) }, () => ground(0, { engineCombustion1: false }))
    case 'pushback':
      return Array.from({ length: n(10, 60) }, () => ground(between(rand, 0.6, 2.2)))
    case 'taxi':
      return Array.from({ length: n(30, 200) }, () => ground(between(rand, 3, 14)))
    case 'fastTaxi':
      // A fast run along a taxiway, past the roll speed but off every runway.
      return Array.from({ length: n(8, 30) }, () => ground(between(rand, 19, 24)))
    case 'lineUpRoll': {
      const length = n(20, 50)
      return Array.from({ length }, (_, i) => ground(2 + ((i + 1) / length) * 75, {}, i > 2))
    }
    case 'rotate':
      return Array.from({ length: n(2, 6) }, (_, i) => air(between(rand, 3, 8), 80 + i * 3, 5 + i * 10))
    case 'climb':
      return Array.from({ length: n(30, 400) }, (_, i) =>
        air(between(rand, 4, 12), 120 + i * 0.1, 100 + i * 20)
      )
    case 'level':
      return Array.from({ length: n(20, 600) }, () => air(between(rand, -0.3, 0.3), 230, 11000))
    case 'descent':
      return Array.from({ length: n(30, 400) }, (_, i) =>
        air(between(rand, -9, -2), 200 - i * 0.1, Math.max(150, 8000 - i * 20))
      )
    case 'touchdown':
      return [air(-2.5, 70, 8), air(-1.5, 70, 2), ground(68, { verticalSpeedMs: -1 }, true)]
    case 'bounce':
      // Back off the ground for one or two ticks, then down again: never a go-around.
      return [
        ...Array.from({ length: n(1, 3) }, () => air(between(rand, 0.5, 2), 65, 2)),
        ground(60, {}, true)
      ]
    case 'rollout': {
      const length = n(15, 40)
      return Array.from({ length }, (_, i) => ground(65 - (i / length) * 50, { parkingBrakeOn: false }, true))
    }
    case 'rolloutBlip': {
      // Slowed below the roll speed on the runway, then a speed blip back over it (reverse thrust, a gust) while still on the
      // ground: not a second takeoff roll.
      const blip = n(2, 8)
      return [
        ...Array.from({ length: n(4, 10) }, () => ground(between(rand, 6, 14), {}, true)),
        ...Array.from({ length: blip }, () => ground(between(rand, 20, 26), {}, true)),
        ...Array.from({ length: n(4, 10) }, () => ground(between(rand, 4, 10), {}, true))
      ]
    }
    case 'taxiIn':
      return Array.from({ length: n(30, 200) }, () => ground(between(rand, 3, 14)))
    case 'park':
      return [
        ...Array.from({ length: n(2, 6) }, () => ground(between(rand, 0, 0.2))),
        ...Array.from({ length: n(2, 10) }, () =>
          ground(0, { parkingBrakeOn: true, engineCombustion1: false })
        )
      ]
    case 'rejectedTakeoff': {
      const up = n(10, 20)
      const down = n(10, 25)
      return [
        ...Array.from({ length: up }, (_, i) => ground(2 + ((i + 1) / up) * 28, {}, i > 2)),
        ...Array.from({ length: down }, (_, i) => ground(30 - ((i + 1) / down) * 24, {}, true))
      ]
    }
    case 'goAround':
      return Array.from({ length: n(5, 20) }, (_, i) => air(between(rand, 2, 6), 70 + i, 10 + i * 8))
  }
}

/**
 * A random flight recipe: the normal flight with the awkward pieces added at random.
 *
 * @param rand The generator.
 * @returns The pieces, in order.
 */
export function randomRecipe(rand: () => number): Recipe {
  const r: Recipe = ['parked', 'pushback', 'taxi']
  if (rand() < 0.3) r.push('fastTaxi', 'taxi')
  if (rand() < 0.3) r.push('lineUpRoll', 'rejectedTakeoff', 'taxi')
  r.push('lineUpRoll', 'rotate', 'climb', 'level')
  if (rand() < 0.4) r.push('climb', 'level')
  r.push('descent')
  if (rand() < 0.25) r.push('level', 'descent')
  if (rand() < 0.3) r.push('touchdown', 'rollout', 'goAround', 'level', 'descent')
  r.push('touchdown')
  if (rand() < 0.5) r.push('bounce')
  if (rand() < 0.3) r.push('bounce')
  r.push('rollout')
  if (rand() < 0.4) r.push('rolloutBlip')
  r.push('taxiIn', 'park')
  return r
}

/** What running one recipe produced. */
export interface Run {
  ticks: Tick[]
  /** The phase after each tick. */
  phases: FlightPhase[]
  /** Which piece each tick belongs to (an index into the recipe). */
  pieceOf: number[]
}

/**
 * Runs a recipe through the phase machine.
 *
 * @param recipe The pieces.
 * @param seed The seed the pieces' random parts come from.
 * @param autoShutdown Whether shutdown at the stand finishes the flight.
 * @returns The ticks and the phase after each.
 */
export function runRecipe(recipe: Recipe, seed: number, autoShutdown = true): Run {
  const rand = seeded(seed)
  const settings: PhaseSettings = {
    paused: false,
    autoShutdown,
    runwayCheck: (lat) => Math.abs(lat - RUNWAY_LAT) < 0.0003
  }
  const ticks: Tick[] = []
  const pieceOf: number[] = []
  for (const [i, kind] of recipe.entries()) {
    for (const tick of pieceTicks(kind, rand)) {
      ticks.push(tick)
      pieceOf.push(i)
    }
  }
  const phases: FlightPhase[] = []
  let state: PhaseState = INITIAL_PHASE_STATE
  const t0 = Date.UTC(2026, 9, 1, 12, 0, 0)
  for (const [i, tick] of ticks.entries()) {
    state = stepPhase(state, tick.t, t0 + i * 1000, settings).state
    phases.push(state.phase)
  }
  return { ticks, phases, pieceOf }
}

/** The ticks (indexes) where the phase became `phase`. */
function entries(run: Run, phase: FlightPhase): number[] {
  return run.phases.flatMap((p, i) => (p === phase && run.phases[i - 1] !== phase ? [i] : []))
}

/** Each rule returns what it saw break, in words, or nothing. */
export type Rule = (run: Run, recipe: Recipe) => string[]

export const RULES: Record<string, Rule> = {
  /** `takeoff` only ever starts on a runway (flight 230, VHHH: a fast taxi was taken for the roll). */
  neverTakeoffOffARunway: (run) =>
    entries(run, 'takeoff')
      .filter((i) => !run.ticks[i]?.onRunway)
      .map((i) => `takeoff began off the runway at tick ${i}`),

  /** Never more than a bounce's few ticks on the ground in climb or cruise (flight 227). */
  neverClimbOrCruiseOnTheGround: (run) => {
    const broken: string[] = []
    let streak = 0
    run.phases.forEach((p, i) => {
      streak = run.ticks[i]?.t.onGround && (p === 'climb' || p === 'cruise') ? streak + 1 : 0
      if (streak === 4) broken.push(`${p} on the ground for more than 3 ticks at tick ${i}`)
    })
    return broken
  },

  /** A landing is followed by taxi and then shutdown at the stand, unless the flight went around. */
  shutdownReachableAfterEveryLanding: (run, recipe) => {
    if (recipe.includes('goAround')) return []
    const landing = run.phases.indexOf('landing')
    if (landing < 0) return ['never reached landing']
    return run.phases.at(-1) === 'shutdown'
      ? []
      : [`ended in ${run.phases.at(-1)} after landing at tick ${landing}`]
  },

  /** A rejected takeoff ends in taxi: it never climbs, and it is not stuck in takeoff. */
  rejectedTakeoffEndsInTaxi: (run, recipe) => {
    const broken: string[] = []
    recipe.forEach((kind, piece) => {
      if (kind !== 'rejectedTakeoff') return
      const ticks = run.pieceOf.flatMap((p, i) => (p === piece ? [i] : []))
      const last = ticks.at(-1)
      if (last === undefined) return
      if (ticks.some((i) => run.phases[i] === 'climb'))
        broken.push(`rejected takeoff climbed (piece ${piece})`)
      if (run.phases[last] !== 'taxi')
        broken.push(`rejected takeoff ended in ${run.phases[last]} at tick ${last}`)
    })
    return broken
  },

  /** A real go-around (airborne for at least 3 ticks after the landing) reaches climb. */
  goAroundReachesClimb: (run, recipe) => {
    const broken: string[] = []
    recipe.forEach((kind, piece) => {
      if (kind !== 'goAround') return
      const ticks = run.pieceOf.flatMap((p, i) => (p === piece ? [i] : []))
      if (!ticks.some((i) => run.phases[i] === 'climb'))
        broken.push(`go-around never reached climb (piece ${piece})`)
    })
    return broken
  },

  /** A bounce (1-2 airborne ticks on the rollout) is not a go-around: the landing does not become a climb. */
  bounceIsNotAGoAround: (run, recipe) => {
    const broken: string[] = []
    recipe.forEach((kind, piece) => {
      if (kind !== 'bounce') return
      const ticks = run.pieceOf.flatMap((p, i) => (p === piece ? [i] : []))
      if (ticks.some((i) => run.phases[i] === 'climb'))
        broken.push(`a bounce was taken for a go-around (piece ${piece})`)
    })
    return broken
  },

  /** After a landing the machine never starts a takeoff roll again unless the flight went around (the rollout speed blip). */
  neverTakeoffAfterLanding: (run, recipe) => {
    if (recipe.includes('goAround')) return []
    const landing = run.phases.indexOf('landing')
    return landing < 0
      ? []
      : entries(run, 'takeoff')
          .filter((i) => i > landing)
          .map((i) => `takeoff began after the landing, at tick ${i}`)
  },

  /** The phases only go forward from the gate: preflight is never re-entered. */
  neverBackToPreflight: (run) =>
    run.phases.flatMap((p, i) =>
      p === 'preflight' && i > 0 && run.phases[i - 1] !== 'preflight'
        ? [`back to preflight at tick ${i}`]
        : []
    )
}

/**
 * Runs every rule over one seeded flight.
 *
 * @param seed The flight's seed.
 * @returns What broke, each with the seed and recipe to replay it.
 */
export function checkSeed(seed: number): string[] {
  const recipe = randomRecipe(seeded(seed * 7919 + 1))
  const run = runRecipe(recipe, seed)
  const broken: string[] = []
  for (const [name, rule] of Object.entries(RULES)) {
    for (const message of rule(run, recipe)) {
      broken.push(`${name}: ${message} (seed ${seed}, recipe ${recipe.join(' > ')})`)
    }
  }
  return broken
}
