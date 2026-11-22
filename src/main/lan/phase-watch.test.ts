import { describe, expect, it } from 'vitest'
import { PhaseWatch } from './phase-watch'

describe('PhaseWatch', () => {
  it('reports the first phase and each change, not a repeat', () => {
    const watch = new PhaseWatch()
    expect(['taxi', 'taxi', 'takeoff', 'takeoff', 'taxi'].map((phase) => watch.changed(phase))).toEqual([
      true,
      false,
      true,
      false,
      true
    ])
  })
})
