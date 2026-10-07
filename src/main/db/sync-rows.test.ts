import { describe, expect, it } from 'vitest'
import { rowsChangedSince, shouldApplyPulledRow } from './sync-rows'

const row = (uuid: string | null, updatedAt: string | null): { uuid: string | null; updatedAt: string | null } => ({
  uuid,
  updatedAt
})

describe('rowsChangedSince', () => {
  const rows = [
    row('c', '2026-10-07T12:00:02Z'),
    row('a', '2026-10-07T12:00:00Z'),
    row(null, '2026-10-07T12:00:05Z'),
    row('b', '2026-10-07T12:00:01Z'),
    row('d', null)
  ]

  it('sends every row with a sync identity, oldest change first, when never synced', () => {
    expect(rowsChangedSince(rows, null).map((r) => r.uuid)).toEqual(['a', 'b', 'c'])
  })

  it('sends only what changed after the cursor', () => {
    expect(rowsChangedSince(rows, '2026-10-07T12:00:01Z').map((r) => r.uuid)).toEqual(['c'])
  })
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
