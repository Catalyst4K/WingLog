import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { listAndSerializeForPush } from '../sync/sync-engine'
import { PULL_PAGE_ROWS, pullPage, twinSyncQueries } from './twin-sync'

describe('a twin’s sync lookups on the host', () => {
  let db: WingLogDb
  let dir: string
  let queries: ReturnType<typeof twinSyncQueries>

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    dir = mkdtempSync(join(tmpdir(), 'winglog-twin-sync-'))
    queries = twinSyncQueries(db, join(dir, 'winglog.db'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function addAircraft(registration: string): void {
    createAircraft(db, { registration, icaoType: 'A320', airline: null, notes: null } as never)
  }

  const pull = (table: string, since: string | null = null, after: unknown = null) =>
    queries['sync.pull'](table, since, after) as ReturnType<typeof pullPage>

  it('serves the rows of a table in the order they changed, as the cloud sync would push them', () => {
    addAircraft('G-AAAA')
    addAircraft('G-BBBB')
    const page = pull('aircraft')
    expect(page.rows.map((row) => JSON.parse(row.data).registration).sort()).toEqual(['G-AAAA', 'G-BBBB'])
    expect(page.next).toBeNull()
    expect(page.rows.map((row) => row.uuid).sort()).toEqual(
      listAndSerializeForPush(db, 'aircraft', null)
        .map((row) => row.uuid)
        .sort()
    )
  })

  it('serves only what changed after the twin’s cursor', () => {
    addAircraft('G-AAAA')
    const everything = pull('aircraft').rows
    const newest = everything
      .map((row) => row.updatedAt)
      .sort()
      .at(-1) as string
    expect(pull('aircraft', newest).rows).toEqual([])
  })

  it('pages a long table, each page after the last, with no row twice or missed', () => {
    for (let i = 0; i < PULL_PAGE_ROWS + 30; i++) addAircraft(`G-${String(i).padStart(4, '0')}`)
    const seen: string[] = []
    let after: unknown = null
    let pages = 0
    do {
      const page = pull('aircraft', null, after)
      seen.push(...page.rows.map((row) => row.uuid))
      after = page.next
      pages += 1
    } while (after)
    expect(pages).toBe(2)
    expect(seen).toHaveLength(PULL_PAGE_ROWS + 30)
    expect(new Set(seen).size).toBe(PULL_PAGE_ROWS + 30)
  })

  it('applies pushed rows by last write wins, and says which were not applied', () => {
    addAircraft('G-AAAA')
    const [row] = listAndSerializeForPush(db, 'aircraft', null)
    const older = { ...row, updatedAt: '2000-01-01T00:00:00.000Z' }
    expect(queries['sync.push']('aircraft', [older])).toEqual({ upserted: [], rejected: [row.uuid] })
    const newer = {
      ...row,
      updatedAt: '2999-01-01T00:00:00.000Z',
      data: JSON.stringify({ ...JSON.parse(row.data), icaoType: 'B738' })
    }
    expect(queries['sync.push']('aircraft', [newer])).toEqual({ upserted: [row.uuid], rejected: [] })
    expect(JSON.parse(listAndSerializeForPush(db, 'aircraft', null)[0].data).icaoType).toBe('B738')
    // The loser is logged next to the database, not lost.
    expect(readFileSync(join(dir, 'sync-conflicts.log'), 'utf8')).toContain('twin-push')
  })

  it('takes a new row from a twin, and refuses one that does not validate', () => {
    const fresh = {
      uuid: '11111111-2222-3333-4444-555555555555',
      updatedAt: new Date().toISOString(),
      data: JSON.stringify({ registration: 'G-NEWW', icaoType: 'B738' })
    }
    expect(queries['sync.push']('aircraft', [fresh])).toMatchObject({ upserted: [fresh.uuid] })
    const bad = { ...fresh, uuid: '99999999-0000-0000-0000-000000000000', data: '{"registration":5}' }
    expect(queries['sync.push']('aircraft', [bad])).toEqual({ upserted: [], rejected: [bad.uuid] })
  })

  it('refuses a table that is not synced, a bad cursor and malformed or oversize rows', () => {
    expect(() => queries['sync.pull']('app_setting', null, null)).toThrow('Unknown table')
    expect(() => queries['sync.pull']('aircraft', 5, null)).toThrow('Invalid cursor')
    expect(() => queries['sync.pull']('aircraft', null, { updatedAt: 1 })).toThrow('Invalid cursor')
    expect(() => queries['sync.push']('aircraft', 'rows')).toThrow('Invalid rows')
    expect(() => queries['sync.push']('aircraft', [{ uuid: 'a' }])).toThrow('Invalid row')
    expect(() =>
      queries['sync.push']('aircraft', [{ uuid: 'a', updatedAt: 'b', data: 'x'.repeat(2_000_000) }])
    ).toThrow('Invalid row')
    expect(() =>
      queries['sync.push'](
        'aircraft',
        Array.from({ length: 501 }, () => ({}))
      )
    ).toThrow('Invalid rows')
  })
})
