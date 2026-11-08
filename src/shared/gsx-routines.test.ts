import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_ROUTINES,
  GSX_ROUTINES_MAX,
  GSX_ROUTINE_MENU,
  GSX_ROUTINE_NAME_MAX,
  GSX_ROUTINE_SERVICES,
  allRoutines,
  checkRoutine,
  isGsxRoutineService,
  parseHiddenBuiltIns,
  parseStoredRoutines,
  routineServices,
  stageRoutine,
  type GsxRoutine,
  type GsxRoutineService
} from './gsx-routines'

const own = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'my-turnaround',
  name: 'A320 turnaround',
  stages: [
    { services: ['Cleaning'], startsWhen: [] },
    { services: ['Catering', 'Refueling'], startsWhen: [{ service: 'Cleaning', state: 'completed' }] },
    { services: ['Boarding'], startsWhen: [{ service: 'Catering', state: 'completed' }] }
  ],
  answerGsxChoice: false,
  fuel: 'ask',
  ...overrides
})

describe('stageRoutine', () => {
  it('lays "A320 turnaround" out as Cleaning, then Catering and Refueling, then Boarding', () => {
    expect(stageRoutine(['Boarding', 'Refueling', 'Cleaning', 'Catering'])).toEqual([
      { services: ['Cleaning'], startsWhen: [] },
      { services: ['Catering', 'Refueling'], startsWhen: [{ service: 'Cleaning', state: 'completed' }] },
      { services: ['Boarding'], startsWhen: [{ service: 'Catering', state: 'completed' }] }
    ])
  })

  it('puts the jetway and GPU first, then Deboarding once the jetway has completed', () => {
    expect(stageRoutine(['Deboarding', 'GPU', 'OperateJetways'])).toEqual([
      { services: ['OperateJetways', 'GPU'], startsWhen: [] },
      { services: ['Deboarding'], startsWhen: [{ service: 'OperateJetways', state: 'completed' }] }
    ])
  })

  it('makes a routine of only Boarding one stage that starts at once', () => {
    expect(stageRoutine(['Boarding'])).toEqual([{ services: ['Boarding'], startsWhen: [] }])
  })

  it('waits only for services that are in the routine', () => {
    // No Cleaning, so Catering and Refueling start with Deboarding; no Catering, so Boarding starts with them.
    expect(stageRoutine(['Deboarding', 'Refueling', 'Boarding'])).toEqual([
      { services: ['Deboarding', 'Refueling', 'Boarding'], startsWhen: [] }
    ])
  })

  it('waits for Cleaning, not for Deboarding, when both Cleaning and Catering are ticked without a jetway', () => {
    expect(stageRoutine(['Cleaning', 'Catering'])).toEqual([
      { services: ['Cleaning'], startsWhen: [] },
      { services: ['Catering'], startsWhen: [{ service: 'Cleaning', state: 'completed' }] }
    ])
  })

  it('ignores a service ticked twice and gives nothing for an empty list', () => {
    expect(stageRoutine(['Water', 'Water'])).toEqual([{ services: ['Water'], startsWhen: [] }])
    expect(stageRoutine([])).toEqual([])
  })

  it('lays every service out in five stages that pass validation', () => {
    const stages = stageRoutine(GSX_ROUTINE_SERVICES)
    expect(stages.map((s) => s.services)).toEqual([
      ['OperateJetways', 'GPU'],
      ['Deboarding'],
      ['Cleaning', 'Lavatory', 'Water'],
      ['Catering', 'Refueling'],
      ['Boarding']
    ])
    expect(checkRoutine(own({ stages })).ok).toBe(true)
  })
})

describe('the built-in routines', () => {
  it('are the three Callum asked for, with fixed ids, and none of them stores a fuel choice', () => {
    expect(BUILT_IN_ROUTINES.map((r) => [r.id, r.builtIn])).toEqual([
      ['builtin-fenix-departure', 'fenix-departure'],
      ['builtin-arrival', 'arrival'],
      ['builtin-turnaround-clean', 'turnaround-clean']
    ])
    expect(BUILT_IN_ROUTINES.every((r) => r.fuel === 'ask')).toBe(true)
  })

  it('the Departure routine is Catering and Refueling, then Boarding once Catering has completed', () => {
    const fenix = BUILT_IN_ROUTINES[0]
    expect(fenix.stages).toEqual([
      { services: ['Catering', 'Refueling'], startsWhen: [] },
      { services: ['Boarding'], startsWhen: [{ service: 'Catering', state: 'completed' }] }
    ])
  })

  it('Arrival is the jetway and GPU, then Deboarding', () => {
    expect(routineServices(BUILT_IN_ROUTINES[1])).toEqual(['OperateJetways', 'GPU', 'Deboarding'])
  })

  it('Turnaround clean is Deboarding, then Cleaning, Lavatory and Water', () => {
    expect(BUILT_IN_ROUTINES[2].stages).toEqual([
      { services: ['Deboarding'], startsWhen: [] },
      {
        services: ['Cleaning', 'Lavatory', 'Water'],
        startsWhen: [{ service: 'Deboarding', state: 'completed' }]
      }
    ])
  })

  it('come first in the list the pilot sees, followed by their own', () => {
    const mine = checkRoutine(own())
    if (!mine.ok) throw new Error(mine.reason)
    expect(allRoutines([mine.routine]).map((r) => r.id)).toEqual([
      'builtin-fenix-departure',
      'builtin-arrival',
      'builtin-turnaround-clean',
      'my-turnaround'
    ])
  })

  it('show the pilot’s version of an example in the example’s place, and not a second time', () => {
    const mine = checkRoutine(own({ id: 'builtin-arrival', name: 'My arrival' }))
    const other = checkRoutine(own())
    if (!mine.ok || !other.ok) throw new Error('fixtures')
    expect(allRoutines([other.routine, mine.routine]).map((r) => [r.id, r.name])).toEqual([
      ['builtin-fenix-departure', 'Departure'],
      ['builtin-arrival', 'My arrival'],
      ['builtin-turnaround-clean', 'Turnaround clean'],
      ['my-turnaround', 'A320 turnaround']
    ])
  })

  it('leave out the ones the pilot deleted', () => {
    expect(allRoutines([], ['builtin-arrival']).map((r) => r.id)).toEqual([
      'builtin-fenix-departure',
      'builtin-turnaround-clean'
    ])
  })

  describe('the stored list of deleted built-ins', () => {
    it('is empty until something is deleted', () => {
      expect(parseHiddenBuiltIns(undefined)).toEqual([])
      expect(parseHiddenBuiltIns('')).toEqual([])
    })

    it('keeps the ids of built-ins, in the built-in order', () => {
      expect(parseHiddenBuiltIns('["builtin-turnaround-clean","builtin-arrival"]')).toEqual([
        'builtin-arrival',
        'builtin-turnaround-clean'
      ])
    })

    it.each([['{broken'], ['{"a":1}'], ['["not-a-routine", 7, null]']])('reads %s as none', (stored) => {
      expect(parseHiddenBuiltIns(stored)).toEqual([])
    })
  })
})

describe('the menu table', () => {
  it('has the recorded labels, with only GPU, Lavatory, Water and Cleaning under Additional Services', () => {
    expect(GSX_ROUTINE_MENU.Catering).toEqual({
      labels: ['Request Catering service'],
      viaAdditionalServices: false
    })
    expect(GSX_ROUTINE_MENU.OperateJetways.labels).toEqual(['Operate Jetway'])
    const oneLevelDown = GSX_ROUTINE_SERVICES.filter((s) => GSX_ROUTINE_MENU[s].viaAdditionalServices)
    expect(oneLevelDown).toEqual(['GPU', 'Lavatory', 'Water', 'Cleaning'])
  })

  it('never offers a label a running service would show, only request labels and the jetway', () => {
    for (const service of GSX_ROUTINE_SERVICES) {
      for (const label of GSX_ROUTINE_MENU[service].labels)
        expect(label.startsWith('Request ') || label === 'Operate Jetway').toBe(true)
    }
  })

  it('knows the GPU by the label Fenix and the A380 show and by the one the PMDG 777 shows', () => {
    expect(GSX_ROUTINE_MENU.GPU.labels).toEqual(['Request GPU', 'Request PMDG Ground Power Unit'])
  })

  it('leaves Pushback and DeIce out', () => {
    expect(isGsxRoutineService('Departure')).toBe(false)
    expect(isGsxRoutineService('DeIce')).toBe(false)
    expect(isGsxRoutineService('GPU')).toBe(true)
    expect(isGsxRoutineService(7)).toBe(false)
  })
})

describe('checkRoutine', () => {
  it('keeps a valid routine, trimming its name', () => {
    const checked = checkRoutine(
      own({ name: '  A320 turnaround  ', fuel: 'simbrief-block', answerGsxChoice: true })
    )
    expect(checked).toEqual({
      ok: true,
      routine: {
        id: 'my-turnaround',
        name: 'A320 turnaround',
        stages: own().stages as GsxRoutine['stages'],
        answerGsxChoice: true,
        fuel: 'simbrief-block'
      }
    })
  })

  it('drops a builtIn mark: only the code can make a built-in', () => {
    const checked = checkRoutine(own({ builtIn: 'arrival' }))
    expect(checked.ok && checked.routine.builtIn).toBeFalsy()
  })

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['null', null]
  ])('refuses %s', (_label, value) => {
    expect(checkRoutine(value).ok).toBe(false)
  })

  it.each([
    ['a missing id', { id: undefined }],
    ['an id with a slash', { id: '../x' }],
    ['an id that is too long', { id: 'a'.repeat(65) }],
    ['a blank name', { name: '   ' }],
    ['a name over the limit', { name: 'x'.repeat(GSX_ROUTINE_NAME_MAX + 1) }],
    ['a fuel choice that is a percentage', { fuel: '80%' }],
    ['answerGsxChoice as text', { answerGsxChoice: 'yes' }],
    ['no stages', { stages: [] }],
    ['ten stages', { stages: Array.from({ length: 10 }, () => ({ services: ['GPU'], startsWhen: [] })) }]
  ])('refuses %s', (_label, overrides) => {
    expect(checkRoutine(own(overrides)).ok).toBe(false)
  })

  it('accepts the id of an example: that is the pilot’s own version of it', () => {
    const checked = checkRoutine(own({ id: 'builtin-arrival', name: 'My arrival' }))
    expect(checked.ok && checked.routine.id).toBe('builtin-arrival')
  })

  it('accepts a name of exactly the limit', () => {
    expect(checkRoutine(own({ name: 'x'.repeat(GSX_ROUTINE_NAME_MAX) })).ok).toBe(true)
  })

  it.each([
    ['Pushback', [{ services: ['Departure'], startsWhen: [] }]],
    ['an empty stage', [{ services: [], startsWhen: [] }]],
    [
      'a service in two stages',
      [
        { services: ['Water'], startsWhen: [] },
        { services: ['Water'], startsWhen: [] }
      ]
    ],
    [
      'a first stage that waits',
      [{ services: ['Water'], startsWhen: [{ service: 'GPU', state: 'completed' }] }]
    ],
    [
      'a stage waiting for a service in a later stage',
      [
        { services: ['Water'], startsWhen: [{ service: 'GPU', state: 'completed' }] },
        { services: ['GPU'], startsWhen: [] }
      ]
    ],
    [
      'a stage waiting for itself',
      [
        { services: ['Water'], startsWhen: [] },
        { services: ['GPU'], startsWhen: [{ service: 'GPU', state: 'completed' }] }
      ]
    ],
    [
      'a condition that is not "completed"',
      [
        { services: ['Water'], startsWhen: [] },
        { services: ['GPU'], startsWhen: [{ service: 'Water', state: 'performing' }] }
      ]
    ],
    ['a stage that is not an object', ['Water']],
    ['a stage without startsWhen', [{ services: ['Water'] }]]
  ])('refuses %s', (_label, stages) => {
    expect(checkRoutine(own({ stages })).ok).toBe(false)
  })

  it('says why it refused', () => {
    const checked = checkRoutine(
      own({
        stages: [
          { services: ['Water'], startsWhen: [] },
          { services: ['Water'], startsWhen: [] }
        ]
      })
    )
    expect(checked).toEqual({ ok: false, reason: 'Water is in the routine twice' })
  })
})

describe('parseStoredRoutines', () => {
  it('gives nothing, and no problem, before anything was saved', () => {
    expect(parseStoredRoutines(undefined)).toEqual({ routines: [], problem: null })
    expect(parseStoredRoutines('')).toEqual({ routines: [], problem: null })
  })

  it('degrades to the built-ins only for text that is not JSON, or not a list', () => {
    expect(parseStoredRoutines('{oops').routines).toEqual([])
    expect(parseStoredRoutines('{oops').problem).toMatch(/not valid JSON/)
    expect(parseStoredRoutines('{"a":1}')).toEqual({
      routines: [],
      problem: 'the stored routines are not a list'
    })
  })

  it('keeps the valid routines and says how many it dropped', () => {
    const stored = JSON.stringify([own(), own({ id: 'bad', name: '' }), own({ id: 'other', name: 'Other' })])
    const read = parseStoredRoutines(stored)
    expect(read.routines.map((r) => r.id)).toEqual(['my-turnaround', 'other'])
    expect(read.problem).toMatch(/^dropped 1 stored routine\(s\): /)
  })

  it('drops a second routine with the same id', () => {
    const read = parseStoredRoutines(JSON.stringify([own(), own({ name: 'Copy' })]))
    expect(read.routines).toHaveLength(1)
    expect(read.problem).toMatch(/used twice/)
  })

  it('reads no more than the limit', () => {
    const many = Array.from({ length: GSX_ROUTINES_MAX + 3 }, (_unused, i) => own({ id: `r-${i}` }))
    const read = parseStoredRoutines(JSON.stringify(many))
    expect(read.routines).toHaveLength(GSX_ROUTINES_MAX)
    expect(read.problem).toMatch(/more than 50/)
  })

  it('round-trips what checkRoutine accepts', () => {
    const services: GsxRoutineService[] = ['GPU', 'Deboarding']
    const checked = checkRoutine(own({ stages: stageRoutine(services) }))
    if (!checked.ok) throw new Error(checked.reason)
    expect(parseStoredRoutines(JSON.stringify([checked.routine])).routines).toEqual([checked.routine])
  })
})
