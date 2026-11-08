import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight } from '../db/flight-repo'
import { flight } from '../db/schema'
import { listAndSerializeForPush } from '../sync/sync-engine'
import { localSyncVersion } from '../sync/sync-version'
import {
  PULL_PAGE_BYTES,
  PULL_PAGE_ROWS,
  twinOrigin,
  twinSyncDeviceQueries,
  twinSyncQueries,
  type PullPage
} from './twin-sync'

const TWIN = 7
const OTHER_TWIN = 8

describe('a twin’s sync lookups on the host', () => {
  let db: WingLogDb
  let dir: string
  let queries: ReturnType<typeof twinSyncQueries>
  let device: ReturnType<typeof twinSyncDeviceQueries>

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    dir = mkdtempSync(join(tmpdir(), 'winglog-twin-sync-'))
    queries = twinSyncQueries(db)
    device = twinSyncDeviceQueries(db, join(dir, 'winglog.db'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function addAircraft(registration: string): { id: number } {
    return createAircraft(db, { registration, icaoType: 'A320' })
  }

  const pull = (table: string, cursor: unknown = null, deviceId = TWIN) =>
    device['sync.pull'](deviceId, table, cursor) as PullPage
  const push = (table: string, rows: unknown, deviceId = TWIN) => device['sync.push'](deviceId, table, rows)

  it('serves the rows of a table in the order they changed, as the cloud sync would push them', () => {
    addAircraft('G-AAAA')
    addAircraft('G-BBBB')
    const page = pull('aircraft')
    expect(page.rows.map((row) => JSON.parse(row.data).registration)).toEqual(['G-AAAA', 'G-BBBB'])
    expect(page.more).toBe(false)
    expect(page.rows.map((row) => row.uuid).sort()).toEqual(
      listAndSerializeForPush(db, 'aircraft', null)
        .map((row) => row.uuid)
        .sort()
    )
  })

  it('serves only what changed after the cursor the twin was given, whatever the rows’ times', () => {
    addAircraft('G-AAAA')
    const first = pull('aircraft')
    expect(pull('aircraft', first.cursor).rows).toEqual([])
    // A row made later, but carrying an earlier time than the first: a time cursor would have lost it.
    const later = addAircraft('G-BBBB')
    expect(JSON.parse(pull('aircraft', first.cursor).rows[0].data).registration).toBe('G-BBBB')
    expect(later.id).toBeGreaterThan(0)
  })

  it('pages a long table, each page after the last, with no row twice or missed', () => {
    for (let i = 0; i < PULL_PAGE_ROWS + 30; i++) addAircraft(`G-${String(i).padStart(4, '0')}`)
    const seen: string[] = []
    let cursor: number | null = null
    let pages = 0
    for (;;) {
      const page: PullPage = pull('aircraft', cursor)
      seen.push(...page.rows.map((row) => row.uuid))
      cursor = page.cursor
      pages += 1
      if (!page.more) break
    }
    expect(pages).toBe(2)
    expect(seen).toHaveLength(PULL_PAGE_ROWS + 30)
    expect(new Set(seen).size).toBe(PULL_PAGE_ROWS + 30)
  })

  it('ends a page when its rows reach the byte budget, but never gives an empty page while there is more', () => {
    const plane = addAircraft('G-ABCD')
    for (let i = 0; i < 3; i++) {
      const trip = createFlight(db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
      db.update(flight)
        .set({ routeString: 'x'.repeat(Math.floor(PULL_PAGE_BYTES * 0.55)) })
        .where(eq(flight.id, trip.id))
        .run()
    }
    const first = pull('flight')
    expect(first.rows).toHaveLength(1)
    expect(first.more).toBe(true)
    const second = pull('flight', first.cursor)
    expect(second.rows).toHaveLength(1)
    expect(second.more).toBe(true)
    expect(pull('flight', second.cursor).more).toBe(false)
  })

  it('leaves out what the asking twin itself pushed, but gives it to another twin and keeps giving it everything else', () => {
    addAircraft('G-HOST')
    const fresh = {
      uuid: '11111111-2222-3333-4444-555555555555',
      updatedAt: new Date().toISOString(),
      data: JSON.stringify({ registration: 'G-TWIN', icaoType: 'B738' })
    }
    expect(push('aircraft', [fresh])).toMatchObject({ upserted: [fresh.uuid] })

    expect(pull('aircraft', null, TWIN).rows.map((r) => JSON.parse(r.data).registration)).toEqual(['G-HOST'])
    expect(pull('aircraft', null, OTHER_TWIN).rows.map((r) => JSON.parse(r.data).registration)).toEqual([
      'G-HOST',
      'G-TWIN'
    ])
  })

  it('moves the cursor past a twin’s own rows, so they never hold up the ones behind them', () => {
    const fresh = {
      uuid: '11111111-2222-3333-4444-555555555555',
      updatedAt: new Date().toISOString(),
      data: JSON.stringify({ registration: 'G-TWIN', icaoType: 'B738' })
    }
    push('aircraft', [fresh])
    const page = pull('aircraft')
    expect(page.rows).toEqual([])
    expect(page.cursor).toBeGreaterThan(0)
    addAircraft('G-AFTR')
    expect(pull('aircraft', page.cursor).rows.map((r) => JSON.parse(r.data).registration)).toEqual(['G-AFTR'])
  })

  it('names a twin’s rows by its device id', () => {
    expect(twinOrigin(7)).toBe('twin:7')
  })

  it('answers the host’s protocol and database version', () => {
    expect(queries['sync.version']()).toEqual(localSyncVersion(db))
    expect(localSyncVersion(db)).toMatchObject({ protocol: 2 })
    expect(localSyncVersion(db).schema).toBeGreaterThan(40)
  })

  it('applies pushed rows by last write wins, and says which were not applied', () => {
    addAircraft('G-AAAA')
    const [row] = listAndSerializeForPush(db, 'aircraft', null)
    const older = { ...row, updatedAt: '2000-01-01T00:00:00.000Z' }
    expect(push('aircraft', [older])).toEqual({ upserted: [], rejected: [row.uuid] })
    const newer = {
      ...row,
      updatedAt: '2999-01-01T00:00:00.000Z',
      data: JSON.stringify({ ...JSON.parse(row.data), icaoType: 'B738' })
    }
    expect(push('aircraft', [newer])).toEqual({ upserted: [row.uuid], rejected: [] })
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
    expect(push('aircraft', [fresh])).toMatchObject({ upserted: [fresh.uuid] })
    const bad = { ...fresh, uuid: '99999999-0000-0000-0000-000000000000', data: '{"registration":5}' }
    expect(push('aircraft', [bad])).toEqual({ upserted: [], rejected: [bad.uuid] })
  })

  it('refuses a table that is not synced, a bad cursor and malformed or oversize rows', () => {
    expect(() => pull('app_setting')).toThrow('Unknown table')
    for (const cursor of [-1, 1.5, '5', {}, true])
      expect(() => pull('aircraft', cursor)).toThrow('Invalid cursor')
    expect(() => push('aircraft', 'rows')).toThrow('Invalid rows')
    expect(() => push('aircraft', [{ uuid: 'a' }])).toThrow('Invalid row')
    expect(() => push('aircraft', [{ uuid: 'a', updatedAt: 'b', data: 'x'.repeat(2_000_000) }])).toThrow(
      'Invalid row'
    )
    expect(() =>
      push(
        'aircraft',
        Array.from({ length: 501 }, () => ({}))
      )
    ).toThrow('Invalid rows')
  })
})
