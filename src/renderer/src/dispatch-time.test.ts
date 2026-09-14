import { describe, expect, it } from 'vitest'
import {
  defaultDepartureTime,
  fromDatetimeLocalValue,
  toDatetimeLocalValue,
  toSimBriefDeparture
} from './dispatch-time'

describe('defaultDepartureTime', () => {
  it('is now + 45 minutes, rounded up to the next 5 minutes', () => {
    expect(defaultDepartureTime(new Date('2026-09-02T18:00:00Z')).toISOString()).toBe('2026-09-02T18:45:00.000Z')
  })

  it('rounds up rather than down when the +45m mark is not a 5-minute boundary', () => {
    expect(defaultDepartureTime(new Date('2026-09-02T18:01:00Z')).toISOString()).toBe('2026-09-02T18:50:00.000Z')
  })

  it('does not round to itself if already on a 5-minute boundary', () => {
    expect(defaultDepartureTime(new Date('2026-09-02T18:15:00Z')).toISOString()).toBe('2026-09-02T19:00:00.000Z')
  })
})

describe('toSimBriefDeparture', () => {
  it('matches the documented known-good conversion (docs/simbrief-notes.md)', () => {
    expect(toSimBriefDeparture(new Date('2026-09-02T18:25:00Z'))).toEqual({
      dateEpochSeconds: 1788307200,
      hour: 18,
      minute: 25
    })
  })

  it('rolls the date forward, in UTC, for a time that rounds past midnight', () => {
    const rolled = defaultDepartureTime(new Date('2026-09-02T23:58:00Z'))
    expect(rolled.toISOString()).toBe('2026-09-03T00:45:00.000Z')
    expect(toSimBriefDeparture(rolled)).toEqual({
      dateEpochSeconds: 1788307200 + 24 * 60 * 60,
      hour: 0,
      minute: 45
    })
  })

  it('returns null for an invalid date', () => {
    expect(toSimBriefDeparture(new Date('not a date'))).toBeNull()
  })

  it('returns null for a date far outside a sane window', () => {
    expect(toSimBriefDeparture(new Date('1970-01-01T00:00:00Z'))).toBeNull()
  })
})

describe('datetime-local round trip', () => {
  it('formats and parses as UTC regardless of the process TZ', () => {
    const date = new Date('2026-09-02T18:25:00Z')
    const formatted = toDatetimeLocalValue(date)
    expect(formatted).toBe('2026-09-02T18:25')
    expect(fromDatetimeLocalValue(formatted)?.toISOString()).toBe(date.toISOString())
  })

  it('returns null for an empty value', () => {
    expect(fromDatetimeLocalValue('')).toBeNull()
  })

  it('returns null for a non-empty value that does not parse as a date', () => {
    expect(fromDatetimeLocalValue('9999-99-99T99:99')).toBeNull()
  })
})
