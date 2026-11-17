import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type WingLogDb } from './client'
import {
  clearDeferredRows,
  countDeferredRows,
  deferRow,
  dropDeferredRow,
  listDeferredRows,
  countDeferredBytes,
  MAX_DEFERRED_BYTES_PER_PEER,
  MAX_DEFERRED_ROWS_PER_PEER,
  MAX_DEFERRED_TIME_AHEAD_MS
} from './sync-deferred-repo'

const row = (uuid: string, updatedAt = '2026-11-14T10:00:00.000Z', data = '{}') => ({ uuid, updatedAt, data })

describe('sync-deferred-repo (security-audit-v2, step 23)', () => {
  let db: WingLogDb

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
  })

  it('keeps a row per peer and table, the newest in place of one kept before, oldest time first', () => {
    expect(deferRow(db, 'cloud', 'aircraft', row('b', '2026-11-14T11:00:00.000Z'))).toBe(true)
    expect(deferRow(db, 'cloud', 'aircraft', row('a', '2026-11-14T09:00:00.000Z', '{"v":1}'))).toBe(true)
    expect(deferRow(db, 'cloud', 'aircraft', row('a', '2026-11-14T10:00:00.000Z', '{"v":2}'))).toBe(true)
    deferRow(db, 'cloud', 'flight', row('f'))
    deferRow(db, 'host', 'aircraft', row('h'))
    expect(listDeferredRows(db, 'cloud', 'aircraft')).toEqual([
      row('a', '2026-11-14T10:00:00.000Z', '{"v":2}'),
      row('b', '2026-11-14T11:00:00.000Z')
    ])
    expect(countDeferredRows(db, 'cloud')).toBe(3)
  })

  it('keeps no more than its limit for one peer, though a row already kept can still be replaced', () => {
    for (let i = 0; i < MAX_DEFERRED_ROWS_PER_PEER; i++)
      expect(deferRow(db, 'host', 'flight', row(`r${i}`))).toBe(true)
    expect(deferRow(db, 'host', 'flight', row('one-too-many'))).toBe(false)
    expect(deferRow(db, 'host', 'flight', row('r0', '2026-11-15T00:00:00.000Z'))).toBe(true)
    expect(deferRow(db, 'cloud', 'flight', row('another-peer'))).toBe(true)
    expect(countDeferredRows(db, 'host')).toBe(MAX_DEFERRED_ROWS_PER_PEER)
  })

  it('keeps no more than its bytes for one peer, though a row already kept can be replaced by one that fits (review of 2026-11-17, finding 4)', () => {
    // The largest row a sync carries is 1.9 MB: 500 of them would be a gigabyte read again at every sync.
    const big = (uuid: string, size = 1_900_000) => row(uuid, '2026-11-14T10:00:00.000Z', 'x'.repeat(size))
    let kept = 0
    while (deferRow(db, 'host', 'flight', big(`big${kept}`))) kept++

    expect(kept).toBe(Math.floor(MAX_DEFERRED_BYTES_PER_PEER / 1_900_000))
    expect(countDeferredRows(db, 'host')).toBe(kept)
    expect(countDeferredBytes(db, 'host')).toBeLessThanOrEqual(MAX_DEFERRED_BYTES_PER_PEER)
    // A smaller row takes the room of the one it replaces; a larger one that no longer fits is refused, and the old one stays.
    expect(deferRow(db, 'host', 'flight', big('big0', 1_000))).toBe(true)
    expect(deferRow(db, 'host', 'flight', big('big1', 4_000_000))).toBe(false)
    expect(listDeferredRows(db, 'host', 'flight').find((r) => r.uuid === 'big1')?.data).toHaveLength(
      1_900_000
    )
    // A small row still fits in the room that is left, and another peer has room of its own.
    expect(deferRow(db, 'host', 'flight', row('small'))).toBe(true)
    expect(deferRow(db, 'cloud', 'flight', big('other-peer'))).toBe(true)
  })

  it('keeps a row up to 30 days ahead of the clock and no further, so a peer with the wrong date does not fill the store (finding 4)', () => {
    const now = Date.parse('2026-11-17T12:00:00.000Z')
    const at = (ms: number) => new Date(now + ms).toISOString()

    expect(deferRow(db, 'cloud', 'flight', row('exactly', at(MAX_DEFERRED_TIME_AHEAD_MS)), now)).toBe(true)
    expect(
      deferRow(db, 'cloud', 'flight', row('a-moment-more', at(MAX_DEFERRED_TIME_AHEAD_MS + 1)), now)
    ).toBe(false)
    expect(deferRow(db, 'cloud', 'flight', row('two-days', at(2 * 24 * 3_600_000)), now)).toBe(true)
    expect(listDeferredRows(db, 'cloud', 'flight').map((r) => r.uuid)).toEqual(['two-days', 'exactly'])
  })

  it('drops one row, or every row of one peer and no other', () => {
    deferRow(db, 'cloud', 'aircraft', row('a'))
    deferRow(db, 'cloud', 'aircraft', row('b'))
    deferRow(db, 'host', 'aircraft', row('h'))
    dropDeferredRow(db, 'cloud', 'aircraft', 'a')
    expect(listDeferredRows(db, 'cloud', 'aircraft').map((r) => r.uuid)).toEqual(['b'])
    clearDeferredRows(db, 'cloud')
    expect(countDeferredRows(db, 'cloud')).toBe(0)
    expect(countDeferredRows(db, 'host')).toBe(1)
  })
})
