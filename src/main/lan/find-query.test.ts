import { describe, expect, it } from 'vitest'
import { findQuery } from './find-query'

describe('findQuery', () => {
  const tables = {
    queries: { echo: (...args: unknown[]) => args, 'sync.version': () => 'v' },
    deviceQueries: { 'sync.pull': (deviceId: number, ...args: unknown[]) => [deviceId, ...args] }
  }

  it('finds a plain lookup for any device, and runs it with the device’s own arguments', () => {
    expect(findQuery(tables, 'screen', 3, 'echo')?.('a', 'b')).toEqual(['a', 'b'])
    expect(findQuery(tables, 'twin', 3, 'echo')?.('a')).toEqual(['a'])
  })

  it('gives a twin’s sync lookup the device id first', () => {
    expect(findQuery(tables, 'twin', 7, 'sync.pull')?.('aircraft', 5)).toEqual([7, 'aircraft', 5])
  })

  it('does not run a lookup that needs a device for one that has none yet', () => {
    expect(findQuery(tables, 'twin', null, 'sync.pull')).toBeNull()
  })

  it('keeps the twin-only lookups from a second screen and from a device that has not paired', () => {
    expect(findQuery(tables, 'screen', 3, 'sync.pull')).toBeNull()
    expect(findQuery(tables, 'screen', 3, 'sync.version')).toBeNull()
    expect(findQuery(tables, null, null, 'sync.version')).toBeNull()
    expect(findQuery(tables, 'twin', 3, 'sync.version')?.()).toBe('v')
  })

  it('finds nothing for a name that is not a lookup, or not a name, including names every object has', () => {
    for (const name of ['nope', '__proto__', 'constructor', 'toString', 5, null, undefined, {}]) {
      expect(findQuery(tables, 'twin', 3, name)).toBeNull()
    }
  })

  it('works when there is no table of device lookups', () => {
    expect(findQuery({ queries: tables.queries }, 'twin', 3, 'sync.pull')).toBeNull()
  })
})
