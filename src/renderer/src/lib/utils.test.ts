import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('joins plain class strings with a space', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy values', () => {
    expect(cn('a', false, undefined, null, 'b')).toBe('a b')
  })

  it('merges conflicting Tailwind classes, keeping the last one', () => {
    // tailwind-merge's whole job: two classes from the same utility group conflict, and
    // only the last should survive — a plain clsx join would keep both, producing broken
    // (or just non-deterministic) CSS.
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })

  it('supports the object and array forms clsx accepts', () => {
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c')
  })
})
