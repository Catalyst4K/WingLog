import { describe, expect, it } from 'vitest'
import { parseUsdAmount } from './money'

// Real strings from docs/gsx-notes.md.
describe('parseUsdAmount', () => {
  it('parses GBP', () => {
    expect(parseUsdAmount('£1,359.71 ~$ 1,818.96')).toBe(1818.96)
  })

  it('parses KRW, which has no decimal places', () => {
    expect(parseUsdAmount('₩18,401 ~$ 13.00')).toBe(13)
  })

  it('parses MYR, a multi-character prefix', () => {
    expect(parseUsdAmount('RM75,246.15 ~$ 18,484.36')).toBe(18484.36)
  })

  it('parses a unitPrice suffix with no space before the $', () => {
    expect(parseUsdAmount('£4.28/pax ~$5.72/pax')).toBe(5.72)
  })

  it('parses a zero-value receipt', () => {
    expect(parseUsdAmount('£0.00 ~$ 0.00')).toBe(0)
  })

  it('returns null for a string with no USD side at all', () => {
    expect(parseUsdAmount('£1,359.71')).toBeNull()
    expect(parseUsdAmount('')).toBeNull()
  })

  it('returns null for a deliberately unparseable string rather than guessing', () => {
    expect(parseUsdAmount('some garbage ~ nonsense')).toBeNull()
  })

  it('returns null rather than Infinity for a number so large it overflows', () => {
    expect(parseUsdAmount(`£1.00 ~$ ${'9'.repeat(400)}`)).toBeNull()
  })
})
