import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { createFlight } from '../db/flight-repo'
import { aircraft, flight, syncChange } from '../db/schema'
import { getKnownCounter, getPullCursor, getPushCursor, markOrigin } from '../db/sync-change-repo'
import { countDeferredRows } from '../db/sync-deferred-repo'
import type { SyncRow, SyncTable } from '../backend/sync-client'
import { runCursorSync, resetPeer, type KnownCounter, type PagedSyncClient } from './cursor-sync'
import { applyPulledRow, serializeChange } from './sync-engine'

/** Later than any row made while the tests run, yet inside the day a peer's row time may be ahead of the clock (`checkedPeerTime`). */
const SOON = new Date(Date.now() + 3_600_000).toISOString()

/** A peer that behaves like the Worker: every write takes the next number, last write wins, and a pull is a page after a cursor. */
class FakePeer implements PagedSyncClient {
  private rows = new Map<SyncTable, Map<string, { row: SyncRow; seq: number }>>()
  private counter = 0
  pageSize = 2
  /** Throw on this (1-based) pull call. */
  failOnPull: number | null = null
  pullCalls = 0
  pushCalls = 0
  /** The cursor asked for on each pull, per table. */
  asked: Record<string, (number | null)[]> = {}
  refuse = new Set<string>()
  stuck = false
  /** When true, each page and push also says this peer's highest change number, in any table (the Worker and the sim PC do). */
  sendHead = false
  /** Says this as the head instead of the real one. */
  headOverride: number | null = null
  /**
   * When true, each page also says the peer's epoch, which changes when a device has seen past the head while holding it or none, as the
   * Worker's and the sim PC's do (review of M8).
   */
  sendEpoch = false
  epoch = 'epoch-1'
  private epochs = 1
  /** What each pull said it knew of the counter. */
  known: KnownCounter[] = []
  /** Run before each pull is answered: a test can change the peer between two tables of one sync. */
  beforePull: ((table: SyncTable) => void) | null = null

  async syncPullPage(
    _e: string,
    _t: string,
    table: SyncTable,
    cursor: number | null,
    known: KnownCounter = { seen: null, epoch: null }
  ) {
    this.pullCalls++
    if (this.failOnPull === this.pullCalls) throw new Error('network down')
    this.beforePull?.(table)
    ;(this.asked[table] ??= []).push(cursor)
    this.known.push(known)
    const seen = Math.max(cursor ?? 0, known.seen ?? 0)
    if (this.sendEpoch && seen > this.counter && (known.epoch === null || known.epoch === this.epoch)) {
      this.newEpoch()
    }
    const after = [...(this.rows.get(table)?.values() ?? [])]
      .filter((entry) => entry.seq > (cursor ?? 0))
      .sort((a, b) => a.seq - b.seq)
    const page = after.slice(0, this.pageSize)
    const more = after.length > page.length
    if (this.stuck) return { rows: page.map((entry) => entry.row), cursor: cursor ?? 0, more: true }
    const head = this.headOverride ?? this.counter
    return {
      rows: page.map((entry) => entry.row),
      cursor: page.at(-1)?.seq ?? cursor ?? 0,
      more,
      ...(this.sendHead ? { head } : {}),
      ...(this.sendEpoch ? { epoch: this.epoch } : {})
    }
  }

  newEpoch(): void {
    this.epoch = `epoch-${++this.epochs}`
  }

  /** The peer starts over, as an account made again or a database restored from a backup does: nothing held, the counter back at zero. */
  wipe(): void {
    this.rows.clear()
    this.counter = 0
    // A new account, or a new database, has a new epoch of its own.
    this.newEpoch()
  }

  /** @returns What the peer holds now, to go back to with `restore`. */
  snapshot(): { rows: Map<SyncTable, Map<string, { row: SyncRow; seq: number }>>; counter: number } {
    return {
      rows: new Map([...this.rows].map(([table, store]) => [table, new Map(store)])),
      counter: this.counter
    }
  }

  /**
   * Goes back to an earlier point, as a point-in-time restore of an account or a backup of the sim PC's database does: the rows and the counter
   * of then, and the epoch it had then, which is the one it has now.
   *
   * @param point What `snapshot` gave.
   */
  restore(point: ReturnType<FakePeer['snapshot']>): void {
    this.rows = new Map([...point.rows].map(([table, store]) => [table, new Map(store)]))
    this.counter = point.counter
  }

  async syncPush(_e: string, _t: string, table: SyncTable, rows: SyncRow[]) {
    this.pushCalls++
    const store = this.rows.get(table) ?? new Map()
    this.rows.set(table, store)
    const upserted: string[] = []
    const rejected: string[] = []
    const refused: string[] = []
    for (const row of rows) {
      const existing = store.get(row.uuid)
      if (this.refuse.has(row.uuid)) refused.push(row.uuid)
      else if (existing && existing.row.updatedAt >= row.updatedAt) rejected.push(row.uuid)
      else {
        store.set(row.uuid, { row, seq: ++this.counter })
        upserted.push(row.uuid)
      }
    }
    return { upserted, rejected, refused, ...(this.sendHead ? { head: this.counter } : {}) }
  }

  seed(table: SyncTable, row: SyncRow): void {
    const store = this.rows.get(table) ?? new Map()
    this.rows.set(table, store)
    store.set(row.uuid, { row, seq: ++this.counter })
  }

  count(table: SyncTable): number {
    return this.rows.get(table)?.size ?? 0
  }
}

const SESSION = { email: 'callum@example.com', token: 'test-token' }

describe('runCursorSync', () => {
  let dir: string
  let peer: FakePeer
  const opened: { db: WingLogDb; path: string }[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-cursor-test-'))
    peer = new FakePeer()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    opened.length = 0
  })

  /** A device: its own database, and the file the conflict log goes next to. */
  function device(name: string): { db: WingLogDb; path: string } {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    const entry = { db: created.db, path: join(dir, `${name}.db`) }
    opened.push(entry)
    return entry
  }
  const sync = (d: { db: WingLogDb; path: string }) => runCursorSync(d.db, peer, SESSION, d.path, 'cloud')

  it('sends what is here on the first sync, takes what the peer has, and is then quiet both ways', async () => {
    const pc = device('pc')
    const mac = device('mac')
    const plane = createAircraft(pc.db, { registration: 'G-ABCD', icaoType: 'A320' })
    createFlight(pc.db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })

    const first = await sync(pc)
    expect(first.tables.aircraft.pushed).toBe(1)
    expect(first.tables.flight.pushed).toBe(1)

    const second = await sync(mac)
    expect(second.tables.aircraft.pulled).toBe(1)
    expect(second.tables.flight.pulled).toBe(1)
    expect(
      mac.db
        .select()
        .from(aircraft)
        .all()
        .map((a) => a.registration)
    ).toEqual(['G-ABCD'])

    // Nothing has changed: the PC takes its own rows back as echoes (no write, nothing reported), the Mac sends nothing it was only given.
    const quietPc = await sync(pc)
    const quietMac = await sync(mac)
    for (const result of [quietPc, quietMac]) {
      for (const table of Object.values(result.tables)) {
        expect(table).toEqual({ pulled: 0, pushed: 0, rejected: [], skipped: [] })
      }
    }
    expect(peer.count('aircraft')).toBe(1)
  })

  it('applies every flight of a table that takes several pages, though only the aircraft pull keeps its rows (audit L15)', async () => {
    const pc = device('pc')
    const mac = device('mac')
    const plane = createAircraft(pc.db, { registration: 'G-ABCD', icaoType: 'A320' })
    for (let i = 0; i < 7; i++)
      createFlight(pc.db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: `EG0${i}` })
    await sync(pc)
    expect(peer.pageSize).toBe(2)

    const result = await sync(mac)

    // 7 flights at 2 a page: four pages, every row applied.
    expect(result.tables.flight.pulled).toBe(7)
    expect(mac.db.select().from(flight).all()).toHaveLength(7)
    expect(peer.asked.flight).toHaveLength(5)
  })

  it('gets an edit pushed after the other device already synced, which a time cursor lost for good', async () => {
    const pc = device('pc')
    const mac = device('mac')
    await sync(pc)
    await sync(mac)
    // The Mac makes a row while the PC syncs, and pushes only afterwards. The row carries the time it was made, which is before the PC's sync.
    const made = createAircraft(mac.db, { registration: 'G-MACB', icaoType: 'A320' })
    await sync(pc)
    await sync(mac)

    const result = await sync(pc)

    expect(result.tables.aircraft.pulled).toBe(1)
    expect(
      pc.db
        .select()
        .from(aircraft)
        .all()
        .map((a) => a.registration)
    ).toEqual(['G-MACB'])
    expect(made.id).toBeGreaterThan(0)
  })

  it('gets a row from a device whose clock is five minutes behind', async () => {
    const pc = device('pc')
    const mac = device('mac')
    await sync(pc)
    const slow = createAircraft(mac.db, { registration: 'G-SLOW', icaoType: 'A320' })
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    mac.db.update(aircraft).set({ updatedAt: fiveMinutesAgo }).where(eq(aircraft.id, slow.id)).run()
    await sync(pc) // moves the PC's place on past the Mac's row's time
    await sync(mac)

    await sync(pc)

    expect(
      pc.db
        .select()
        .from(aircraft)
        .all()
        .map((a) => a.registration)
    ).toEqual(['G-SLOW'])
  })

  it('sends on a row that came from another peer, but not back to the peer it came from', async () => {
    const host = device('host')
    // A row a twin pushed to this device: applied here and marked with the twin as its origin.
    const row: SyncRow = {
      uuid: 'from-twin',
      updatedAt: '2026-11-01T00:00:00.000Z',
      data: JSON.stringify({ registration: 'G-TWIN', icaoType: 'A320' })
    }
    expect(applyPulledRow(host.db, 'aircraft', row).ok).toBe(true)
    markOrigin(host.db, 'aircraft', 'from-twin', 'twin:3')
    const viaCloud = await sync(host)
    expect(viaCloud.tables.aircraft.pushed).toBe(1)

    // And a row taken from the cloud is not sent straight back to it.
    peer.seed('aircraft', {
      uuid: 'from-cloud',
      updatedAt: '2026-11-02T00:00:00.000Z',
      data: JSON.stringify({ registration: 'G-CLOD', icaoType: 'A320' })
    })
    const next = await sync(host)
    expect(next.tables.aircraft.pulled).toBe(1)
    expect(next.tables.aircraft.pushed).toBe(0)
    expect(peer.count('aircraft')).toBe(2)
  })

  it('counts a local edit to a row that came from the peer as a change to send', async () => {
    const pc = device('pc')
    const mac = device('mac')
    createAircraft(pc.db, { registration: 'G-ABCD', icaoType: 'A320' })
    await sync(pc)
    await sync(mac)
    mac.db.update(aircraft).set({ icaoType: 'A321', updatedAt: SOON }).run()

    const result = await sync(mac)

    expect(result.tables.aircraft.pushed).toBe(1)
    await sync(pc)
    expect(pc.db.select().from(aircraft).get()?.icaoType).toBe('A321')
  })

  it('carries on from the page it reached when a pull fails part-way, instead of starting again', async () => {
    const source = device('source')
    const plane = createAircraft(source.db, { registration: 'G-ABCD', icaoType: 'A320' })
    for (let i = 0; i < 6; i++)
      createFlight(source.db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: `EG${i}0` })
    await sync(source)
    const fresh = device('fresh')
    peer.asked = {}
    peer.pullCalls = 0
    peer.failOnPull = 4 // the aircraft page, then flight pages 1 and 2 succeed, and page 3 fails

    await expect(sync(fresh)).rejects.toThrow('network down')

    expect(fresh.db.select().from(flight).all()).toHaveLength(4)
    expect(getPullCursor(fresh.db, 'cloud', 'flight')).toBeGreaterThan(0)
    peer.failOnPull = null
    peer.asked = {}
    await sync(fresh)
    expect(fresh.db.select().from(flight).all()).toHaveLength(6)
    expect(peer.asked.flight?.[0]).toBeGreaterThan(0) // resumed after the pages it had, not from the top
  })

  it('does not let a change that cannot be sent stop the ones behind it, and does not try it again', async () => {
    const pc = device('pc')
    const orphan = createAircraft(pc.db, { registration: 'G-GONE', icaoType: 'A320' })
    createAircraft(pc.db, { registration: 'G-FINE', icaoType: 'A320' })
    // The first aircraft loses its uuid after being counted, as a row that cannot be found by its counted uuid.
    pc.db.update(aircraft).set({ uuid: null }).where(eq(aircraft.id, orphan.id)).run()

    const first = await sync(pc)
    const second = await sync(pc)

    expect(first.tables.aircraft.skipped).toHaveLength(1)
    expect(first.tables.aircraft.pushed).toBe(1)
    expect(second.tables.aircraft.skipped).toEqual([])
    expect(second.tables.aircraft.pushed).toBe(0)
  })

  it('marks a merged row under the local uuid it was written under, so it is not sent back and the pulled uuid has no entry', async () => {
    const pc = device('pc')
    const plane = createAircraft(pc.db, { registration: 'G-ABCD', icaoType: 'A320' })
    const mine = createFlight(pc.db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
    pc.db
      .update(flight)
      .set({ status: 'completed', actualOutUtc: '2026-04-12T22:52:00.000Z' })
      .where(eq(flight.id, mine.id))
      .run()
    const localUuid = pc.db.select().from(flight).get()?.uuid as string
    const planeUuid = pc.db.select().from(aircraft).get()?.uuid as string
    // Another device's copy of the same flight, under its own uuid, newer than the local one.
    peer.seed('flight', {
      uuid: 'their-flight',
      updatedAt: SOON,
      data: JSON.stringify({
        aircraftUuid: planeUuid,
        depIcao: 'EGLL',
        arrIcao: 'EGCC',
        status: 'completed',
        actualOutUtc: '2026-04-12T22:52:00.000Z',
        fuelBurnKg: 1234
      })
    })

    const result = await sync(pc)

    const entries = pc.db.select().from(syncChange).where(eq(syncChange.tableName, 'flight')).all()
    expect(entries.map((e) => e.uuid)).toEqual([localUuid])
    expect(entries[0].origin).toBe('cloud')
    expect(pc.db.select().from(flight).get()?.fuelBurnKg).toBe(1234)
    expect(result.tables.flight.pushed).toBe(0)
  })

  it('reports a row the backend refused as skipped, and still sends the rest', async () => {
    const pc = device('pc')
    const bad = createAircraft(pc.db, { registration: 'G-BAD1', icaoType: 'A320' })
    createAircraft(pc.db, { registration: 'G-GOOD', icaoType: 'A320' })
    peer.refuse.add(pc.db.select().from(aircraft).where(eq(aircraft.id, bad.id)).get()?.uuid as string)

    const result = await sync(pc)

    expect(result.tables.aircraft.pushed).toBe(1)
    expect(result.tables.aircraft.skipped).toHaveLength(1)
  })

  it('sets aside a row too large for the backend and carries on', async () => {
    const pc = device('pc')
    const plane = createAircraft(pc.db, { registration: 'G-ABCD', icaoType: 'A320' })
    const big = createFlight(pc.db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
    pc.db
      .update(flight)
      .set({ routeString: 'x'.repeat(2_000_000) })
      .where(eq(flight.id, big.id))
      .run()

    const result = await sync(pc)

    expect(result.tables.flight.skipped).toHaveLength(1)
    expect(result.tables.aircraft.pushed).toBe(1)
  })

  it('refuses a peer that says there is more but does not move the cursor, rather than looping for ever', async () => {
    const pc = device('pc')
    peer.seed('aircraft', {
      uuid: 'x',
      updatedAt: '2026-11-01T00:00:00.000Z',
      data: JSON.stringify({ registration: 'G-STCK', icaoType: 'A320' })
    })
    peer.stuck = true
    await expect(sync(pc)).rejects.toThrow('did not move the cursor on')
  })

  it('takes a row given back with its time written the short way as the same write, not a conflict (review nit)', async () => {
    const pc = device('pc')
    const row = {
      uuid: 'short-time',
      updatedAt: '2026-11-11T10:00:00Z',
      data: JSON.stringify({ registration: 'G-SHRT', icaoType: 'A320' })
    }
    peer.seed('aircraft', row)
    expect((await sync(pc)).tables.aircraft.pulled).toBe(1)
    // Stored here as 10:00:00.000Z; the peer gives the same write back, still written 10:00:00Z.
    peer.seed('aircraft', row)
    const again = await sync(pc)
    expect(again.tables.aircraft.rejected).toEqual([])
  })

  it('keeps a real edit refused because this computer’s clock is two days slow, and applies it once the clock is right (step 23)', async () => {
    const pc = device('pc')
    peer.seed('aircraft', {
      uuid: 'edited-elsewhere',
      updatedAt: new Date().toISOString(),
      data: JSON.stringify({ registration: 'G-LATE', icaoType: 'A320' })
    })
    const realNow = Date.now()
    const slowClock = vi.spyOn(Date, 'now').mockReturnValue(realNow - 2 * 24 * 3_600_000)
    try {
      const slow = await sync(pc)
      expect(slow.tables.aircraft.pulled).toBe(0)
      expect(slow.tables.aircraft.skipped).toEqual(['edited-elsewhere'])
      expect(countDeferredRows(pc.db, 'cloud')).toBe(1)
      // Still slow at the next sync: kept, not applied, and not lost.
      await sync(pc)
      expect(countDeferredRows(pc.db, 'cloud')).toBe(1)
    } finally {
      slowClock.mockRestore()
    }

    // The clock is put right. The peer has nothing new (the cursor is past the row), yet the row is applied.
    const right = await sync(pc)
    expect(right.tables.aircraft.pulled).toBe(1)
    expect(countDeferredRows(pc.db, 'cloud')).toBe(0)
    expect(
      pc.db
        .select()
        .from(aircraft)
        .all()
        .map((a) => a.registration)
    ).toEqual(['G-LATE'])
  })

  it('still passes over for good a row whose time is not a real time', async () => {
    const pc = device('pc')
    peer.seed('aircraft', {
      uuid: 'bad-time',
      updatedAt: 'zzzz',
      data: JSON.stringify({ registration: 'G-ZZZZ', icaoType: 'A320' })
    })
    expect((await sync(pc)).tables.aircraft.skipped).toEqual(['bad-time'])
    expect(countDeferredRows(pc.db, 'cloud')).toBe(0)
  })

  it('does a full sync both ways again after the peer’s cursors are forgotten', async () => {
    const pc = device('pc')
    createAircraft(pc.db, { registration: 'G-ABCD', icaoType: 'A320' })
    await sync(pc)
    expect(getPushCursor(pc.db, 'cloud', 'aircraft')).toBeGreaterThan(0)
    const before = peer.pushCalls

    resetPeer(pc.db, 'cloud')
    expect(getPushCursor(pc.db, 'cloud', 'aircraft')).toBe(0)
    expect(getPullCursor(pc.db, 'cloud', 'aircraft')).toBeNull()
    const again = await sync(pc)

    expect(peer.pushCalls).toBeGreaterThan(before)
    expect(again.tables.aircraft.rejected).toHaveLength(1) // sent again, and the peer already had it
    expect(
      pc.db
        .select()
        .from(syncChange)
        .where(and(eq(syncChange.tableName, 'aircraft')))
        .all()
    ).toHaveLength(1)
  })
})

describe('a peer whose counter went back (audit M8)', () => {
  let dir: string
  let peer: FakePeer

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-cursor-head-'))
    peer = new FakePeer()
    peer.sendHead = true
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function device(name: string): { db: WingLogDb; path: string } {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    return { db: created.db, path: join(dir, `${name}.db`) }
  }
  const sync = (d: { db: WingLogDb; path: string }) => runCursorSync(d.db, peer, SESSION, d.path, 'cloud')
  const registrations = (d: { db: WingLogDb }): string[] =>
    d.db
      .select()
      .from(aircraft)
      .all()
      .map((a) => a.registration)
      .sort()

  /** A computer that has synced three aircraft with a peer, which is then wiped and gets one aircraft from another computer. */
  async function wipedPeer(): Promise<{ pc: { db: WingLogDb; path: string } }> {
    const pc = device('pc')
    for (const registration of ['G-AAAA', 'G-BBBB', 'G-CCCC']) {
      createAircraft(pc.db, { registration, icaoType: 'A320' })
    }
    // The first sync sends; the second takes the echoes back, which is what moves the pull cursor.
    await sync(pc)
    await sync(pc)
    expect(getPullCursor(pc.db, 'cloud', 'aircraft')).toBe(3)
    peer.wipe()
    peer.seed('aircraft', {
      uuid: 'from-the-new-account',
      updatedAt: '2026-11-11T10:00:00.000Z',
      data: JSON.stringify({ registration: 'G-NEWW', icaoType: 'B738' })
    })
    return { pc }
  }

  it('starts the peer again when its newest change is behind the cursor, and so takes its rows and sends this computer’s', async () => {
    const { pc } = await wipedPeer()

    const result = await sync(pc)

    expect(registrations(pc)).toEqual(['G-AAAA', 'G-BBBB', 'G-CCCC', 'G-NEWW'])
    expect(peer.count('aircraft')).toBe(4)
    expect(result.tables.aircraft.pulled).toBe(1)
    expect(result.tables.aircraft.pushed).toBe(3)
    // The cursor sent first, then none: the whole table asked for again.
    expect(peer.asked.aircraft.slice(-2)).toEqual([3, null])
    expect(readFileSync(join(dir, 'sync-conflicts.log'), 'utf8')).toContain('counter went back')
  })

  it('does nothing of the kind while the cursor is at or below the newest change', async () => {
    const pc = device('pc')
    createAircraft(pc.db, { registration: 'G-AAAA', icaoType: 'A320' })
    await sync(pc)
    await sync(pc)
    const asked = peer.asked.aircraft.length
    await sync(pc)
    // Asked once more, from the cursor, and not again from the start.
    expect(peer.asked.aircraft.slice(asked)).toEqual([1])
  })

  it('leaves a peer that sends no head as it is: the old behaviour, which never gets the new account’s rows', async () => {
    const { pc } = await wipedPeer()
    peer.sendHead = false

    const result = await sync(pc)

    expect(result.tables.aircraft.pulled).toBe(0)
    expect(registrations(pc)).toEqual(['G-AAAA', 'G-BBBB', 'G-CCCC'])
    expect(peer.count('aircraft')).toBe(1)
  })

  it('starts again once per sync, so a peer that keeps saying a low head fails the sync instead of holding it in a loop', async () => {
    const { pc } = await wipedPeer()
    peer.headOverride = 0
    const before = peer.asked.aircraft.length

    await expect(sync(pc)).rejects.toThrow('counter went back')

    // Cursor 3 once, then none; the second time it is found, in the restarted run, the sync stops.
    expect(peer.asked.aircraft.slice(before)).toEqual([3, null])
    expect(registrations(pc)).toContain('G-NEWW')
  })

  it('sends back the rows it took from the peer once the peer starts again, so a new account or database gets them too (review of M8)', async () => {
    const pc = device('pc')
    createAircraft(pc.db, { registration: 'G-AAAA', icaoType: 'A320' })
    peer.seed('aircraft', {
      uuid: 'made-elsewhere',
      updatedAt: '2026-11-11T09:00:00.000Z',
      data: JSON.stringify({ registration: 'G-ELSE', icaoType: 'B738' })
    })
    await sync(pc)
    await sync(pc)
    expect(registrations(pc)).toEqual(['G-AAAA', 'G-ELSE'])

    peer.wipe()
    await sync(pc)

    // G-ELSE came from the peer, but the peer it came from is gone: it is sent too, not only what was made here.
    expect(peer.count('aircraft')).toBe(2)
  })

  it('starts the second computer again too after a restore, though the first one’s re-send has taken the head past it (review of M8)', async () => {
    peer.sendEpoch = true
    const pc = device('pc')
    const mac = device('mac')
    const add = (d: { db: WingLogDb }, registration: string) =>
      createAircraft(d.db, { registration, icaoType: 'A320' })
    add(pc, 'G-PCAA')
    await sync(pc)
    await sync(mac)
    const point = peer.snapshot()
    // After the restore point the PC sends three, and the Mac takes them and sends one of its own that the PC never takes.
    for (const registration of ['G-PCBB', 'G-PCCC', 'G-PCDD']) add(pc, registration)
    await sync(pc)
    add(mac, 'G-MACB')
    await sync(mac)
    peer.restore(point)

    // The PC, which made four more meanwhile, syncs first: it has seen past the restored head, so the peer gives a new epoch, and its re-send
    // takes the head past everything the Mac has seen, so the head alone would not tell the Mac.
    for (const registration of ['G-PCEE', 'G-PCFF', 'G-PCGG', 'G-PCHH']) add(pc, registration)
    await sync(pc)
    expect(peer.epoch).toBe('epoch-2')
    expect(peer.snapshot().counter).toBeGreaterThan(getKnownCounter(mac.db, 'cloud').seen ?? 0)

    await sync(mac)
    await sync(pc)

    // The Mac's row made after the restore point reached the peer again, and both computers have every row.
    expect(peer.count('aircraft')).toBe(9)
    expect(registrations(pc)).toContain('G-MACB')
    expect(registrations(mac)).toEqual(registrations(pc))
  })

  it('counts a push’s head as seen, so a restore to just before the push still shows (review of M8)', async () => {
    peer.sendEpoch = true
    const pc = device('pc')
    // Only the aircraft table, so no later table's pull in the same sync says the head the push took it to: the push's own answer has to.
    const syncAircraft = () => runCursorSync(pc.db, peer, SESSION, pc.path, 'cloud', ['aircraft'])
    createAircraft(pc.db, { registration: 'G-AAAA', icaoType: 'A320' })
    await syncAircraft()
    await syncAircraft()
    const point = peer.snapshot()
    // The pull finds nothing new, so the pull cursor stays at the restore point; only the push's answer says the counter moved past it.
    createAircraft(pc.db, { registration: 'G-BBBB', icaoType: 'A320' })
    await syncAircraft()
    expect(getPullCursor(pc.db, 'cloud', 'aircraft')).toBe(point.counter)
    peer.restore(point)

    await syncAircraft()

    expect(peer.count('aircraft')).toBe(2)
  })

  it('starts the whole sync again from the first table, so a flight is never pulled before an aircraft it needs (review of M8)', async () => {
    peer.sendEpoch = true
    const pc = device('pc')
    const mac = device('mac')
    createAircraft(pc.db, { registration: 'G-PCAA', icaoType: 'A320' })
    await sync(pc)
    await sync(pc)
    // The Mac's aircraft and a flight on it reach the peer, and its epoch changes, between the PC's aircraft pull and its flight pull.
    const plane = createAircraft(mac.db, { registration: 'G-MACX', icaoType: 'A320' })
    const trip = createFlight(mac.db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
    const uuidOf = (table: typeof aircraft | typeof flight, id: number): string =>
      mac.db.select({ uuid: table.uuid }).from(table).where(eq(table.id, id)).get()?.uuid as string
    let changed = false
    peer.beforePull = (table) => {
      if (table !== 'flight' || changed) return
      changed = true
      peer.seed('aircraft', serializeChange(mac.db, 'aircraft', uuidOf(aircraft, plane.id)) as SyncRow)
      peer.seed('flight', serializeChange(mac.db, 'flight', uuidOf(flight, trip.id)) as SyncRow)
      peer.newEpoch()
    }

    const result = await sync(pc)

    expect(result.tables.flight.skipped).toEqual([])
    expect(
      pc.db
        .select()
        .from(flight)
        .all()
        .map((f) => f.uuid)
    ).toEqual([uuidOf(flight, trip.id)])
    expect(registrations(pc)).toEqual(['G-MACX', 'G-PCAA'])
  })
})
