import { describe, expect, it } from 'vitest'
import { shouldRelaunch } from './e2e-relaunch'

describe('shouldRelaunch', () => {
  it('starts the app again unless an e2e run asked it not to', () => {
    expect(shouldRelaunch(false, undefined)).toBe(true)
    expect(shouldRelaunch(false, '0')).toBe(true)
    expect(shouldRelaunch(false, '1')).toBe(false)
  })

  it('always starts a packaged build again', () => {
    expect(shouldRelaunch(true, '1')).toBe(true)
  })
})
