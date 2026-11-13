import { describe, expect, it } from 'vitest'
import { checkedPeerTime, isPeerTimeAhead, MAX_PEER_TIME_AHEAD_MS, shouldApplyPulledRow } from './sync-rows'

const row = (
  uuid: string | null,
  updatedAt: string | null
): { uuid: string | null; updatedAt: string | null } => ({
  uuid,
  updatedAt
})

describe('shouldApplyPulledRow', () => {
  it('applies a row that is new here, or newer than the local edit', () => {
    expect(shouldApplyPulledRow(undefined, '2026-10-07T12:00:00Z')).toBe(true)
    expect(shouldApplyPulledRow(row('a', '2026-10-07T12:00:00Z'), '2026-10-07T12:00:01Z')).toBe(true)
  })

  it('keeps a local edit made at the same time or later: last write wins', () => {
    expect(shouldApplyPulledRow(row('a', '2026-10-07T12:00:01Z'), '2026-10-07T12:00:00Z')).toBe(false)
    expect(shouldApplyPulledRow(row('a', '2026-10-07T12:00:01Z'), '2026-10-07T12:00:01Z')).toBe(false)
  })

  it('applies the pulled row when either side has no time to compare', () => {
    expect(shouldApplyPulledRow(row('a', null), '2026-10-07T12:00:00Z')).toBe(true)
    expect(shouldApplyPulledRow(row('a', '2026-10-07T12:00:00Z'), undefined)).toBe(true)
  })
})

describe('checkedPeerTime (audit M2)', () => {
  const NOW = Date.parse('2026-11-11T12:00:00.000Z')

  it('returns a real UTC time in toISOString’s form, adding the milliseconds a shorter time leaves out', () => {
    expect(checkedPeerTime('2026-11-11T10:00:00Z', NOW)).toBe('2026-11-11T10:00:00.000Z')
    expect(checkedPeerTime('2026-11-11T10:00:00.5Z', NOW)).toBe('2026-11-11T10:00:00.500Z')
    expect(checkedPeerTime('2026-11-11T10:00:00.123Z', NOW)).toBe('2026-11-11T10:00:00.123Z')
  })

  it.each([
    ['text that is not a time', 'zzzz'],
    ['an empty string', ''],
    ['a date with no time', '2026-11-11'],
    ['a time with an offset instead of Z', '2026-11-11T10:00:00+01:00'],
    ['a time with no Z', '2026-11-11T10:00:00'],
    ['four fractional digits', '2026-11-11T10:00:00.1234Z'],
    ['a month that does not exist', '2026-13-01T00:00:00Z'],
    ['an hour that does not exist', '2026-11-11T25:00:00Z'],
    ['a 31st of February', '2026-02-31T00:00:00Z'],
    ['a text with a time hidden in it', 'x2026-11-11T10:00:00Zx']
  ])('refuses %s', (_name, value) => {
    expect(checkedPeerTime(value, NOW)).toBeNull()
  })

  it.each([[null], [undefined], [12345], [{}], [['2026-11-11T10:00:00Z']]])(
    'refuses %j, which is not text',
    (value) => {
      expect(checkedPeerTime(value, NOW)).toBeNull()
    }
  )

  it('accepts a time up to a day ahead of the clock and refuses one further ahead', () => {
    expect(checkedPeerTime(new Date(NOW + MAX_PEER_TIME_AHEAD_MS).toISOString(), NOW)).not.toBeNull()
    expect(checkedPeerTime(new Date(NOW + MAX_PEER_TIME_AHEAD_MS + 1).toISOString(), NOW)).toBeNull()
    expect(checkedPeerTime('9999-12-31T23:59:59.999Z', NOW)).toBeNull()
  })

  it('accepts any time in the past', () => {
    expect(checkedPeerTime('1999-01-01T00:00:00.000Z', NOW)).toBe('1999-01-01T00:00:00.000Z')
  })
})

describe('isPeerTimeAhead (security-audit-v2, step 23)', () => {
  const NOW = Date.parse('2026-11-11T12:00:00.000Z')

  it('is true only for a real time refused for being more than a day ahead', () => {
    expect(isPeerTimeAhead(new Date(NOW + MAX_PEER_TIME_AHEAD_MS + 1).toISOString(), NOW)).toBe(true)
    expect(isPeerTimeAhead('9999-12-31T23:59:59.999Z', NOW)).toBe(true)
    expect(isPeerTimeAhead(new Date(NOW + MAX_PEER_TIME_AHEAD_MS).toISOString(), NOW)).toBe(false)
    expect(isPeerTimeAhead('2026-11-11T10:00:00Z', NOW)).toBe(false)
  })

  it('is false for what is not a real time, which is refused for good', () => {
    for (const value of ['zzzz', '2027-02-31T00:00:00.000Z', '2027-01-01T00:00:00+01:00', 5, null, undefined]) {
      expect(isPeerTimeAhead(value, NOW), String(value)).toBe(false)
    }
  })
})
