import { describe, expect, it } from 'vitest'
import { shouldApplyPulledRow } from './sync-rows'

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
