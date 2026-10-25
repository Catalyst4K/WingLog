import { describe, expect, it } from 'vitest'
import { autoTuneWarning, beyondAtcSuppressed } from './beyondatc-online'

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

describe('autoTuneWarning', () => {
  it.each(['online', 'probably'] as const)(
    'warns when the pilot is %s and a connected BeyondATC has auto tune on',
    (state) => {
      expect(autoTuneWarning(state, true, true)).toBe(true)
    }
  )

  it.each(['unknown', 'offline'] as const)('says nothing when the pilot is %s', (state) => {
    expect(autoTuneWarning(state, true, true)).toBe(false)
  })

  it('says nothing while auto tune is off, or before BeyondATC has said', () => {
    expect(autoTuneWarning('online', true, false)).toBe(false)
    expect(autoTuneWarning('online', true, null)).toBe(false)
  })

  it('says nothing once BeyondATC has closed, though its last auto tune value was on', () => {
    expect(autoTuneWarning('online', false, true)).toBe(false)
  })
})
