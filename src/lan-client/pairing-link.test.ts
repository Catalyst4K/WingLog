import { describe, expect, it } from 'vitest'
import { codeFromHash } from './pairing-link'

describe('codeFromHash', () => {
  it('reads the six-digit code from a scanned address', () => {
    expect(codeFromHash('#code=482913')).toBe('482913')
    expect(codeFromHash('#code=004217')).toBe('004217')
  })

  it('reads nothing from anything else', () => {
    for (const hash of [
      '',
      '#',
      '#code=',
      '#code=12345',
      '#code=1234567',
      '#code=abcdef',
      '#code=482913&x=1',
      '#x=1&code=482913',
      '#code=482913#more',
      'code=482913',
      '#CODE=482913',
      '#code=48 913',
      '#code=<script>'
    ]) {
      expect(codeFromHash(hash), hash).toBeNull()
    }
  })
})
