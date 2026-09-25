import { describe, expect, it } from 'vitest'
import { resolveMaintenanceAddon } from './addon-for-type'

describe('resolveMaintenanceAddon', () => {
  it.each(['B772', 'B773', 'B77L', 'B77W'])('resolves %s (Boeing 777 family) to pmdg777', (icaoType) => {
    expect(resolveMaintenanceAddon(icaoType)).toBe('pmdg777')
  })

  it.each(['A359', 'A35K'])('resolves %s (Airbus A350 family) to inibuildsA350', (icaoType) => {
    expect(resolveMaintenanceAddon(icaoType)).toBe('inibuildsA350')
  })

  it('is case-insensitive', () => {
    expect(resolveMaintenanceAddon('b77w')).toBe('pmdg777')
    expect(resolveMaintenanceAddon('a359')).toBe('inibuildsA350')
  })

  it('returns null for a type that is neither a 777 nor an A350', () => {
    expect(resolveMaintenanceAddon('B738')).toBeNull()
  })

  it('returns null for an empty type', () => {
    expect(resolveMaintenanceAddon('')).toBeNull()
  })
})
