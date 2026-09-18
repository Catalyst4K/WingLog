import { describe, expect, it } from 'vitest'
import { isVisualApproach, visualApproachIdentifier, visualApproachRunway } from './visual-approach'

describe('visual approach identifier', () => {
  it('round-trips a runway through the identifier', () => {
    expect(visualApproachIdentifier('27R')).toBe('Visual 27R')
    expect(visualApproachRunway('Visual 27R')).toBe('27R')
  })

  it('recognises only its own identifiers, never a real approach or null', () => {
    expect(isVisualApproach('Visual 09L')).toBe(true)
    expect(isVisualApproach('ILS 27R')).toBe(false)
    expect(isVisualApproach('RNAV Z 07R')).toBe(false)
    expect(isVisualApproach(null)).toBe(false)
    expect(visualApproachRunway('ILS 27R')).toBeNull()
  })
})
