import { describe, expect, it } from 'vitest'
import { beyondAtcSuppressed } from './beyondatc-online'

describe('beyondAtcSuppressed', () => {
  it.each(['online', 'probably'] as const)('hides BeyondATC when the pilot is %s', (state) => {
    expect(beyondAtcSuppressed(state, false)).toBe(true)
  })

  it.each(['unknown', 'offline'] as const)('leaves BeyondATC alone when the pilot is %s', (state) => {
    expect(beyondAtcSuppressed(state, false)).toBe(false)
  })

  it.each(['online', 'probably', 'unknown', 'offline'] as const)(
    'never hides it when the pilot asked to keep it (%s)',
    (state) => {
      expect(beyondAtcSuppressed(state, true)).toBe(false)
    }
  )
})
