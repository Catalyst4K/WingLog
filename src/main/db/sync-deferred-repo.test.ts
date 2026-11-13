import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type WingLogDb } from './client'
import {
  clearDeferredRows,
  countDeferredRows,
  deferRow,
  dropDeferredRow,
  listDeferredRows,
  MAX_DEFERRED_ROWS_PER_PEER
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
