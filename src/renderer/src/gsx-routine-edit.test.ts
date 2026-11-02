import { describe, expect, it } from 'vitest'
import { GSX_ROUTINE_NAME_MAX, checkRoutine, stageRoutine, type GsxRoutine } from '@shared/gsx-routines'
import {
  blankRoutine,
  copyRoutine,
  moveService,
  routineProblem,
  sanitizeStages,
  setStartsWhen,
  toggleService
} from './gsx-routine-edit'

const turnaround = stageRoutine(['Cleaning', 'Catering', 'Refueling', 'Boarding'])

/** A stage list passes the same validation the main process applies when it is saved. */
function isValid(stages: GsxRoutine['stages']): boolean {
  return checkRoutine({ id: 'x', name: 'x', stages, answerGsxChoice: false, fuel: 'ask' }).ok
}

describe('toggleService', () => {
  it('lays the stages out again with the default rule when a service is ticked', () => {
    expect(toggleService(stageRoutine(['Catering']), 'Boarding')).toEqual(
      stageRoutine(['Catering', 'Boarding'])
    )
  })

  it('lays them out again when one is unticked, so nothing waits for a service that is gone', () => {
    expect(toggleService(turnaround, 'Cleaning')).toEqual(stageRoutine(['Catering', 'Refueling', 'Boarding']))
  })

  it('starts from nothing', () => {
    expect(toggleService([], 'GPU')).toEqual([{ services: ['GPU'], startsWhen: [] }])
  })

  it('gives no stages when the last service is unticked', () => {
    expect(toggleService(stageRoutine(['GPU']), 'GPU')).toEqual([])
  })
})

describe('moveService', () => {
  it('moves a service to another stage', () => {
    const moved = moveService(turnaround, 'Refueling', 0)
    expect(moved[0].services).toEqual(['Cleaning', 'Refueling'])
    expect(moved[1].services).toEqual(['Catering'])
    expect(isValid(moved)).toBe(true)
  })

  it('moves a service to a new stage at the end', () => {
    const moved = moveService(turnaround, 'Cleaning', turnaround.length)
    expect(moved.at(-1)).toEqual({ services: ['Cleaning'], startsWhen: [] })
    expect(isValid(moved)).toBe(true)
  })

  it('drops a stage the move emptied, and the waits that pointed at it', () => {
    const moved = moveService(turnaround, 'Cleaning', 1)
    expect(moved.map((stage) => stage.services)).toEqual([
      ['Catering', 'Refueling', 'Cleaning'],
      ['Boarding']
    ])
    expect(moved[0].startsWhen).toEqual([])
    expect(isValid(moved)).toBe(true)
  })

  it('drops a wait that no longer points at an earlier stage', () => {
    // Boarding waits for Catering; moving Catering after Boarding must not leave Boarding waiting for a later stage.
    const moved = moveService(turnaround, 'Catering', 3)
    expect(isValid(moved)).toBe(true)
    for (const [index, stage] of moved.entries()) {
      const earlier = moved.slice(0, index).flatMap((s) => s.services)
      for (const condition of stage.startsWhen) expect(earlier).toContain(condition.service)
    }
  })

  it('clamps a stage past the end to a new stage', () => {
    expect(moveService(stageRoutine(['GPU', 'Deboarding']), 'GPU', 99).at(-1)?.services).toEqual(['GPU'])
  })

  it('keeps every service exactly once', () => {
    const moved = moveService(turnaround, 'Catering', 0)
    expect(moved.flatMap((s) => s.services).sort()).toEqual(['Boarding', 'Catering', 'Cleaning', 'Refueling'])
  })
})

describe('setStartsWhen', () => {
  it('makes a stage wait for a service in an earlier stage', () => {
    const changed = setStartsWhen(turnaround, 2, 'Cleaning')
    expect(changed[2].startsWhen).toEqual([{ service: 'Cleaning', state: 'completed' }])
    expect(isValid(changed)).toBe(true)
  })

  it('makes a stage start at once', () => {
    expect(setStartsWhen(turnaround, 1, null)[1].startsWhen).toEqual([])
  })

  it('refuses a service that is not in an earlier stage', () => {
    expect(setStartsWhen(turnaround, 1, 'Boarding')).toEqual(turnaround)
    expect(setStartsWhen(turnaround, 1, 'Catering')).toEqual(turnaround)
    expect(setStartsWhen(turnaround, 0, 'Cleaning')).toEqual(turnaround)
  })

  it('does not change the stages it was given', () => {
    const before = structuredClone(turnaround)
    setStartsWhen(turnaround, 2, null)
    expect(turnaround).toEqual(before)
  })
})

describe('sanitizeStages', () => {
  it('removes empty stages and clears the first stage’s wait', () => {
    const cleaned = sanitizeStages([
      { services: ['GPU'], startsWhen: [{ service: 'Water', state: 'completed' }] },
      { services: [], startsWhen: [] },
      { services: ['Deboarding'], startsWhen: [{ service: 'GPU', state: 'completed' }] }
    ])
    expect(cleaned).toEqual([
      { services: ['GPU'], startsWhen: [] },
      { services: ['Deboarding'], startsWhen: [{ service: 'GPU', state: 'completed' }] }
    ])
  })
})

describe('copying and starting a routine', () => {
  it('copies a built-in without the built-in mark, and the copy passes validation', () => {
    const builtIn: GsxRoutine = {
      id: 'builtin-arrival',
      name: 'Arrival',
      builtIn: 'arrival',
      stages: stageRoutine(['OperateJetways', 'GPU', 'Deboarding']),
      answerGsxChoice: true,
      fuel: 'ask'
    }
    const copy = copyRoutine(builtIn, 'abc-123', 'Arrival copy')
    expect(copy.builtIn).toBeUndefined()
    expect(copy).toMatchObject({ id: 'abc-123', name: 'Arrival copy', answerGsxChoice: true })
    expect(checkRoutine(copy).ok).toBe(true)
  })

  it('does not share its stages with the original', () => {
    const original: GsxRoutine = { ...blankRoutine('a', 'A'), stages: stageRoutine(['GPU']) }
    const copy = copyRoutine(original, 'b', 'B')
    copy.stages[0].services.push('Water')
    expect(original.stages[0].services).toEqual(['GPU'])
  })

  it('cuts a long name to the limit', () => {
    expect(copyRoutine(blankRoutine('a', 'A'), 'b', 'x'.repeat(60)).name).toHaveLength(GSX_ROUTINE_NAME_MAX)
  })

  it('starts a new routine with nothing ticked, asking for the fuel level', () => {
    expect(blankRoutine('n', 'New')).toEqual({
      id: 'n',
      name: 'New',
      stages: [],
      answerGsxChoice: false,
      fuel: 'ask'
    })
  })
})

describe('routineProblem', () => {
  const ready = { ...blankRoutine('a', 'A'), stages: stageRoutine(['GPU']) }

  it('is null for a routine that can be saved', () => {
    expect(routineProblem(ready)).toBeNull()
  })

  it('says the name is the problem when it is blank or too long', () => {
    expect(routineProblem({ ...ready, name: '   ' })).toBe('name')
    expect(routineProblem({ ...ready, name: 'x'.repeat(GSX_ROUTINE_NAME_MAX + 1) })).toBe('name')
  })

  it('says services when none are ticked', () => {
    expect(routineProblem(blankRoutine('a', 'A'))).toBe('services')
  })
})
