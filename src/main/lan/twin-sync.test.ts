import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight } from '../db/flight-repo'
import { aircraft, flight } from '../db/schema'
import { localSyncVersion } from '../sync/sync-version'
import { countDeferredRows } from '../db/sync-deferred-repo'
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

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  function addAircraft(registration: string): { id: number } {
    return createAircraft(db, { registration, icaoType: 'A320' })
  }

  const pull = (table: string, cursor: unknown = null, deviceId = TWIN, known?: unknown) =>
    device['sync.pull'](deviceId, table, cursor, known) as PullPage
  const push = (table: string, rows: unknown, deviceId = TWIN) =>
    device['sync.push'](deviceId, table, rows) as Promise<{
      upserted: string[]
      rejected: string[]
      head: number
    }>

  it('serves the rows of a table in the order they changed, as the cloud sync would push them', () => {
    addAircraft('G-AAAA')
    addAircraft('G-BBBB')
    const page = pull('aircraft')
    expect(page.rows.map((row) => JSON.parse(row.data).registration)).toEqual(['G-AAAA', 'G-BBBB'])
    expect(page.more).toBe(false)
    expect(page.rows.map((row) => row.uuid).sort()).toEqual(
      db
        .select()
        .from(aircraft)
        .all()
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
    // The page time budget is tested below; here the clock stands still so only the row limit ends a page.
    vi.spyOn(performance, 'now').mockReturnValue(0)
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

  it('ends a page when building it has taken its time budget, so a big pull is many short pages and none is lost', () => {
    for (let i = 0; i < 12; i++) addAircraft(`G-${String(i).padStart(4, '0')}`)
    // Every look at the clock is 100 ms later than the last: a page holds one row and then ends.
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 100))
    const seen: string[] = []
    let cursor: number | null = null
    let pages = 0
    for (;;) {
      const page: PullPage = pull('aircraft', cursor)
      expect(page.rows.length).toBeGreaterThan(0)
      seen.push(...page.rows.map((row) => row.uuid))
      cursor = page.cursor
      pages += 1
      if (!page.more) break
    }
    expect(pages).toBe(12)
    expect(new Set(seen).size).toBe(12)
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

  it('leaves out what the asking twin itself pushed, but gives it to another twin and keeps giving it everything else', async () => {
    addAircraft('G-HOST')
    const fresh = {
      uuid: '11111111-2222-3333-4444-555555555555',
      updatedAt: new Date().toISOString(),
      data: JSON.stringify({ registration: 'G-TWIN', icaoType: 'B738' })
    }
    expect(await push('aircraft', [fresh])).toMatchObject({ upserted: [fresh.uuid] })

    expect(pull('aircraft', null, TWIN).rows.map((r) => JSON.parse(r.data).registration)).toMatchObject([
      'G-HOST'
    ])
    expect(pull('aircraft', null, OTHER_TWIN).rows.map((r) => JSON.parse(r.data).registration)).toEqual([
      'G-HOST',
      'G-TWIN'
    ])
  })

  it('moves the cursor past a twin’s own rows, so they never hold up the ones behind them', async () => {
    const fresh = {
      uuid: '11111111-2222-3333-4444-555555555555',
      updatedAt: new Date().toISOString(),
      data: JSON.stringify({ registration: 'G-TWIN', icaoType: 'B738' })
    }
    await push('aircraft', [fresh])
    const page = pull('aircraft')
    expect(page.rows).toEqual([])
    expect(page.cursor).toBeGreaterThan(0)
    addAircraft('G-AFTR')
    expect(pull('aircraft', page.cursor).rows.map((r) => JSON.parse(r.data).registration)).toEqual(['G-AFTR'])
  })

  it('says the highest change number it has given, in any table, so a twin can tell its counter went back (audit M8)', async () => {
    expect(pull('aircraft').head).toBe(0)
    addAircraft('G-AAAA')
    addAircraft('G-BBBB')
    const first = pull('aircraft')
    expect(first.head).toBe(first.cursor)
    expect(first.head).toBeGreaterThan(0)
    // The counter is the database's own, shared by its tables: a table with no rows says the same head.
    expect(pull('flight').head).toBe(first.head)
    const fresh = {
      uuid: '11111111-2222-3333-4444-555555555555',
      updatedAt: new Date().toISOString(),
      data: JSON.stringify({ registration: 'G-TWIN', icaoType: 'B738' })
    }
    // A push says the head it took the counter to, before the twin pulls again (review of M8).
    const pushed = await push('aircraft', [fresh])
    expect(pushed.head).toBeGreaterThan(first.head)
    expect(pull('aircraft', first.cursor, OTHER_TWIN).head).toBe(pushed.head)
  })

  it('does not lower the head when the row holding the newest change is deleted outright (review of M8)', () => {
    addAircraft('G-AAAA')
    addAircraft('G-BBBB')
    const before = pull('aircraft').head
    db.delete(aircraft).where(eq(aircraft.registration, 'G-BBBB')).run()
    expect(pull('aircraft').head).toBe(before)
  })

  it('keeps one epoch while the counter only goes up, and gives a new one when a twin has seen past the head (review of M8)', () => {
    const epoch = pull('aircraft').epoch
    expect(epoch).toMatch(/^[0-9a-f-]{36}$/)
    addAircraft('G-AAAA')
    const head = pull('aircraft').head
    expect(pull('aircraft', head, TWIN, { seen: head, epoch }).epoch).toBe(epoch)

    // A restored database: a twin says it has seen past the head while it holds this epoch. Every twin is given the new one.
    const fresh = pull('aircraft', null, TWIN, { seen: head + 10, epoch }).epoch
    expect(fresh).not.toBe(epoch)
    expect(pull('aircraft', null, OTHER_TWIN, { seen: head + 10, epoch }).epoch).toBe(fresh)
    // An older twin sends nothing, and is taken at its cursor.
    expect(pull('aircraft', null, OTHER_TWIN).epoch).toBe(fresh)
  })

  it('refuses a counter from a twin that is not one', () => {
    for (const known of [{ seen: -1 }, { seen: '3' }, { epoch: 5 }, { epoch: 'x'.repeat(65) }, 'text']) {
      expect(() => pull('aircraft', null, TWIN, known), JSON.stringify(known)).toThrow()
    }
  })

  it('names a twin’s rows by its device id', () => {
    expect(twinOrigin(7)).toBe('twin:7')
  })

  it('answers the host’s protocol and database version', () => {
    expect(queries['sync.version']()).toEqual(localSyncVersion(db))
    expect(localSyncVersion(db)).toMatchObject({ protocol: 2 })
    expect(localSyncVersion(db).schema).toBeGreaterThan(40)
  })

  it('tells the window when a push stored rows, and not when it stored none', async () => {
    const applied = vi.fn()
    const watching = twinSyncDeviceQueries(db, join(dir, 'winglog.db'), applied)
    const row = {
      uuid: 'pushed-aircraft',
      updatedAt: '2026-11-09T10:00:00.000Z',
      data: JSON.stringify({ registration: 'G-PUSH', icaoType: 'A320' })
    }
    await watching['sync.push'](TWIN, 'aircraft', [row])
    expect(applied).toHaveBeenCalledTimes(1)
    // The same row again changes nothing here.
    await watching['sync.push'](TWIN, 'aircraft', [row])
    expect(applied).toHaveBeenCalledTimes(1)
    await watching['sync.push'](TWIN, 'aircraft', [])
    expect(applied).toHaveBeenCalledTimes(1)
  })

  it('applies pushed rows by last write wins, and says which were not applied', async () => {
    addAircraft('G-AAAA')
    const [row] = pull('aircraft', null, OTHER_TWIN).rows
    const older = { ...row, updatedAt: '2000-01-01T00:00:00.000Z' }
    expect(await push('aircraft', [older])).toMatchObject({ upserted: [], rejected: [row.uuid] })
    const newer = {
      ...row,
      updatedAt: new Date(Date.now() + 3_600_000).toISOString(),
      data: JSON.stringify({ ...JSON.parse(row.data), icaoType: 'B738' })
    }
    expect(await push('aircraft', [newer])).toMatchObject({ upserted: [row.uuid], rejected: [] })
    expect(JSON.parse(pull('aircraft', null, OTHER_TWIN).rows[0].data).icaoType).toBe('B738')
    // The loser is logged next to the database, not lost.
    expect(readFileSync(join(dir, 'sync-conflicts.log'), 'utf8')).toContain('twin-push')
  })

  it('takes a new row from a twin, and refuses one that does not validate', async () => {
    const fresh = {
      uuid: '11111111-2222-3333-4444-555555555555',
      updatedAt: new Date().toISOString(),
      data: JSON.stringify({ registration: 'G-NEWW', icaoType: 'B738' })
    }
    expect(await push('aircraft', [fresh])).toMatchObject({ upserted: [fresh.uuid] })
    const bad = { ...fresh, uuid: '99999999-0000-0000-0000-000000000000', data: '{"registration":5}' }
    expect(await push('aircraft', [bad])).toMatchObject({ upserted: [], rejected: [bad.uuid] })
  })

  it('refuses a twin row timed zzzz, and still takes a real, newer edit to the same row from another twin (audit M2)', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555'
    const data = (icaoType: string): string => JSON.stringify({ registration: 'G-ZZZZ', icaoType })
    expect(await push('aircraft', [{ uuid, updatedAt: 'zzzz', data: data('A320') }], TWIN)).toMatchObject({
      upserted: [],
      rejected: [uuid]
    })
    expect(
      await push('aircraft', [{ uuid, updatedAt: '9999-12-31T23:59:59.999Z', data: data('A320') }], TWIN)
    ).toMatchObject({
      upserted: [],
      rejected: [uuid]
    })
    const real = new Date().toISOString()
    expect(await push('aircraft', [{ uuid, updatedAt: real, data: data('B738') }], OTHER_TWIN)).toMatchObject(
      {
        upserted: [uuid],
        rejected: []
      }
    )
    expect(JSON.parse(pull('aircraft', null, TWIN).rows[0].data).icaoType).toBe('B738')
  })

  it('applies a twin push’s other rows when one has a bad time', async () => {
    const good = (n: number): { uuid: string; updatedAt: string; data: string } => ({
      uuid: `00000000-0000-0000-0000-00000000000${n}`,
      updatedAt: new Date().toISOString(),
      data: JSON.stringify({ registration: `G-GOO${n}`, icaoType: 'A320' })
    })
    const bad = { ...good(2), updatedAt: 'zzzz' }
    expect(await push('aircraft', [good(1), bad, good(3)])).toMatchObject({
      upserted: [good(1).uuid, good(3).uuid],
      rejected: [bad.uuid]
    })
  })

  it('keeps a twin’s real edit refused because this computer’s clock is slow, and applies it at that twin’s next sync (step 23)', async () => {
    const fresh = {
      uuid: '11111111-2222-3333-4444-555555555555',
      updatedAt: new Date().toISOString(),
      data: JSON.stringify({ registration: 'G-LATE', icaoType: 'A320' })
    }
    const realNow = Date.now()
    const slowClock = vi.spyOn(Date, 'now').mockReturnValue(realNow - 2 * 24 * 3_600_000)
    try {
      expect(await push('aircraft', [fresh])).toMatchObject({ upserted: [], rejected: [fresh.uuid] })
      expect(countDeferredRows(db, twinOrigin(TWIN))).toBe(1)
    } finally {
      slowClock.mockRestore()
    }
    expect(pull('aircraft', null, OTHER_TWIN).rows).toEqual([])
    // The clock is right again; the twin pulls (it has nothing new to push) and the kept row is applied, then given to the other twin.
    pull('aircraft', null, TWIN)
    expect(countDeferredRows(db, twinOrigin(TWIN))).toBe(0)
    expect(pull('aircraft', null, OTHER_TWIN).rows.map((r) => JSON.parse(r.data).registration)).toEqual([
      'G-LATE'
    ])
    // It counts as the twin's own, so it is not handed back to it.
    expect(pull('aircraft', null, TWIN).rows).toEqual([])
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
  it('refuses a pushed row that is not an object at all', () => {
    expect(() => push('aircraft', [null])).toThrow('Invalid row')
    expect(() => push('aircraft', ['row'])).toThrow('Invalid row')
  })
})
