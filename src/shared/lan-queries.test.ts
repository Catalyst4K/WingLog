import { describe, expect, it } from 'vitest'
import { isKept, isWorthKeeping, laneOf, LAN_QUERY_KINDS } from './lan-queries'

describe('the lookup table', () => {
  it('puts the lookups that reach the sim or the internet in the slow lane, and answers from the PC’s own data in the fast one', () => {
    for (const name of ['navdata.refreshAirport', 'taxi.refresh', 'stands', 'weather.metars'])
      expect(laneOf(name)).toBe('slow')
    for (const name of [
      'navdata.procedureWaypoints',
      'navdata.listSids',
      'taxi.get',
      'settings.display',
      'airfields'
    ])
      expect(laneOf(name)).toBe('fast')
  })

  it('treats a name it does not know as a quick lookup that is not kept', () => {
    expect(laneOf('something.new')).toBe('fast')
    expect(isKept('something.new')).toBe(false)
    expect(laneOf('__proto__')).toBe('fast')
    expect(isKept('__proto__')).toBe(false)
  })

  it('keeps what only changes when the PC refreshes it, and never the settings or weather', () => {
    expect(isKept('navdata.procedureWaypoints')).toBe(true)
    expect(isKept('airfields')).toBe(true)
    expect(isKept('settings.display')).toBe(false)
    expect(isKept('weather.metars')).toBe(false)
    expect(isKept('taxi.has')).toBe(false)
    // A slow lookup is a fetch, not a read.
    for (const [name, kind] of Object.entries(LAN_QUERY_KINDS))
      if (kind.lane === 'slow') expect(isKept(name)).toBe(false)
  })

  it('keeps an answer that says something, not an empty one', () => {
    expect(isWorthKeeping([{ icao: 'WSSS' }])).toBe(true)
    expect(isWorthKeeping({ a: 1 })).toBe(true)
    expect(isWorthKeeping(true)).toBe(true)
    expect(isWorthKeeping([])).toBe(false)
    expect(isWorthKeeping(null)).toBe(false)
    expect(isWorthKeeping(undefined)).toBe(false)
    expect(isWorthKeeping(false)).toBe(false)
  })
})
