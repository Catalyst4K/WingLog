import { describe, expect, it } from 'vitest'
import type { FlightPhase } from '@shared/ipc'
import { isPastLanding } from './phase-strip'

const points = (...phases: FlightPhase[]): Array<{ phase: FlightPhase }> => phases.map((phase) => ({ phase }))

describe('isPastLanding', () => {
  it('is false before takeoff, however long the taxi', () => {
    expect(isPastLanding([])).toBe(false)
    expect(isPastLanding(points('pushback', 'taxi', 'taxi'))).toBe(false)
  })

  it('is false from takeoff to the touchdown', () => {
    expect(isPastLanding(points('pushback', 'taxi', 'takeoff', 'climb', 'cruise', 'descent'))).toBe(false)
  })

  it('is true once the aircraft has landed, through the taxi in', () => {
    expect(
      isPastLanding(points('taxi', 'takeoff', 'climb', 'cruise', 'descent', 'landing', 'taxi', 'taxi'))
    ).toBe(true)
  })

  it('follows the last leg of a circuit: touch-and-go, up again, then a new descent', () => {
    expect(isPastLanding(points('taxi', 'takeoff', 'climb', 'descent', 'landing', 'climb', 'descent'))).toBe(
      true
    )
    // A takeoff after that landing makes the next taxi a "Taxi out" again.
    expect(isPastLanding(points('takeoff', 'landing', 'takeoff', 'climb'))).toBe(false)
    expect(isPastLanding(points('takeoff', 'landing', 'takeoff', 'landing', 'taxi'))).toBe(true)
  })
})
