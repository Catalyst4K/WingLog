import { describe, expect, it } from 'vitest'
import { RULES, checkSeed, randomRecipe, runRecipe, seeded, type Recipe } from './phase-rules'

describe('phase machine rules', () => {
  it('hold over 3,000 seeded flights', () => {
    const broken: string[] = []
    for (let seed = 1; seed <= 3000; seed++) {
      broken.push(...checkSeed(seed))
      if (broken.length >= 5) break
    }
    expect(broken).toEqual([])
  })

  it('cover every piece: the flights include rejected takeoffs, fast taxis, bounces and go-arounds', () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= 300; seed++)
      for (const kind of randomRecipe(seeded(seed * 7919 + 1))) seen.add(kind)
    for (const kind of [
      'rejectedTakeoff',
      'fastTaxi',
      'bounce',
      'goAround',
      'touchdown',
      'park',
      'rolloutBlip'
    ])
      expect(seen.has(kind)).toBe(true)
  })

  it('are reproducible from the seed', () => {
    const recipe = randomRecipe(seeded(42))
    expect(runRecipe(recipe, 42).phases).toEqual(runRecipe(recipe, 42).phases)
  })

  it('a normal flight goes through every phase in order', () => {
    const normal: Recipe = [
      'parked',
      'pushback',
      'taxi',
      'lineUpRoll',
      'rotate',
      'climb',
      'level',
      'descent',
      'touchdown',
      'rollout',
      'taxiIn',
      'park'
    ]
    const { phases } = runRecipe(normal, 7)
    const order = [
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
    ]
    expect(phases.filter((p, i) => p !== phases[i - 1])).toEqual(order)
  })

  it('catch a broken machine: a fast taxi taken for the takeoff roll breaks the rule', () => {
    // The rules read the run, so feed one where takeoff began on a taxiway.
    const recipe: Recipe = ['parked', 'pushback', 'taxi', 'fastTaxi']
    const run = runRecipe(recipe, 3)
    const ok = RULES.neverTakeoffOffARunway!(run, recipe)
    expect(ok).toEqual([])
    const forged = { ...run, phases: run.phases.map(() => 'takeoff' as const) }
    expect(RULES.neverTakeoffOffARunway!(forged, recipe).length).toBeGreaterThan(0)
    const stuck = {
      ...run,
      phases: run.phases.map(() => 'cruise' as const),
      ticks: run.ticks.map((t) => ({ ...t, t: { ...t.t, onGround: true } }))
    }
    expect(RULES.neverClimbOrCruiseOnTheGround!(stuck, recipe).length).toBeGreaterThan(0)
  })
})
