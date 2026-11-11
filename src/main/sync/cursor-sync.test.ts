import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { createFlight } from '../db/flight-repo'
import { aircraft, flight, syncChange } from '../db/schema'
import { getPullCursor, getPushCursor, markOrigin } from '../db/sync-change-repo'
import type { SyncRow, SyncTable } from '../backend/sync-client'
import { runCursorSync, resetPeer, type PagedSyncClient } from './cursor-sync'
import { applyPulledRow } from './sync-engine'

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

  async syncPullPage(_e: string, _t: string, table: SyncTable, cursor: number | null) {
    this.pullCalls++
    if (this.failOnPull === this.pullCalls) throw new Error('network down')
    ;(this.asked[table] ??= []).push(cursor)
    const after = [...(this.rows.get(table)?.values() ?? [])]
      .filter((entry) => entry.seq > (cursor ?? 0))
      .sort((a, b) => a.seq - b.seq)
    const page = after.slice(0, this.pageSize)
    const more = after.length > page.length
    if (this.stuck) return { rows: page.map((entry) => entry.row), cursor: cursor ?? 0, more: true }
    return { rows: page.map((entry) => entry.row), cursor: page.at(-1)?.seq ?? cursor ?? 0, more }
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
    return { upserted, rejected, refused }
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
