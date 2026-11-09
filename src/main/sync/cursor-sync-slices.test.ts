import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import type { SyncRow } from '../backend/sync-client'

// Every row is followed by a call to the slicer, which is what lets the app breathe during a big sync (finding F11).
const slices = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./time-slice', () => ({
  timeSlicer: () => () => {
    slices.calls += 1
    return Promise.resolve()
  }
}))
vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

import { runCursorSync } from './cursor-sync'
import { applyPushedRows } from './sync-engine'

describe('a sync gives the thread back between rows', () => {
  let db: WingLogDb

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    slices.calls = 0
  })

  const aircraftRow = (i: number): SyncRow => ({
    uuid: `pulled-${i}`,
    updatedAt: '2026-11-09T10:00:00.000Z',
    data: JSON.stringify({ registration: `G-P${String(i).padStart(3, '0')}`, icaoType: 'A320' })
  })

  it('after each row it pulls and each row it sends', async () => {
    createAircraft(db, { registration: 'G-LOCL', icaoType: 'A320' })
    createAircraft(db, { registration: 'G-LOC2', icaoType: 'A320' })
    const pulled = [aircraftRow(1), aircraftRow(2), aircraftRow(3)]
    const pushed: SyncRow[] = []
    const peer = {
      syncPullPage: (_e: string, _t: string, table: string) =>
        Promise.resolve({ rows: table === 'aircraft' ? pulled : [], cursor: 1, more: false }),
      syncPush: (_e: string, _t: string, _table: string, rows: SyncRow[]) => {
        pushed.push(...rows)
        return Promise.resolve({ upserted: rows.map((r) => r.uuid), rejected: [] })
      }
    }
    const result = await runCursorSync(db, peer, { email: 'a', token: 'b' }, ':memory:', 'cloud')
    expect(result.tables.aircraft.pulled).toBe(3)
    // The aircraft made here (and the three pulled, which are not sent back to where they came from) are what gets pushed.
    expect(pushed.length).toBe(2)
    expect(slices.calls).toBeGreaterThanOrEqual(3 + 2)
  })

  it('after each row the host applies from a twin’s push', async () => {
    const rows = [aircraftRow(1), aircraftRow(2), aircraftRow(3), aircraftRow(4)]
    const result = await applyPushedRows(db, 'aircraft', rows, ':memory:', 'twin:1')
    expect(result.upserted).toHaveLength(4)
    expect(slices.calls).toBe(4)
  })
})
