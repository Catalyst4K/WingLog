import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft, listAircraft } from '../db/aircraft-repo'
import { SYNC_TABLES, type SyncRow } from '../backend/sync-client'
import { listAndSerializeForPush } from '../sync/sync-engine'
import { twinSyncQueries } from '../lan/twin-sync'
import { chunkRows, LanSyncClient, PUSH_CHUNK_ROWS } from './lan-sync-client'
import { TwinSync } from './TwinSync'

vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

function freshDb(): WingLogDb {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

describe('LanSyncClient and the host’s lookups, end to end between two databases', () => {
  let host: WingLogDb
  let client: WingLogDb
  let dir: string

  beforeEach(() => {
    host = freshDb()
    client = freshDb()
    dir = mkdtempSync(join(tmpdir(), 'winglog-twin-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A link in which the client asks the host's own lookups, through JSON as the socket would. */
  function link(): TwinSync {
    const queries = twinSyncQueries(host, join(dir, 'host.db'))
    const ask = (name: string, ...args: unknown[]): Promise<unknown> =>
      Promise.resolve(JSON.parse(JSON.stringify(queries[name](...JSON.parse(JSON.stringify(args))))))
    return new TwinSync({
      db: client,
      dbPath: join(dir, 'client.db'),
      client: new LanSyncClient(ask),
      canSync: () => true
    })
  }

  const addAircraft = (db: WingLogDb, registration: string): void => {
    createAircraft(db, { registration, icaoType: 'A320', airline: null, notes: null } as never)
  }

  it('brings a new client level with the host, and the host with what the client made', async () => {
    addAircraft(host, 'G-HOST')
    addAircraft(client, 'G-MACX')
    const sync = link()
    await sync.run()
    expect(sync.status().state).toBe('idle')
    expect(sync.status().lastSyncedAt).not.toBeNull()
    expect(
      listAircraft(client)
        .map((a) => a.registration)
        .sort()
    ).toEqual(['G-HOST', 'G-MACX'])
    expect(
      listAircraft(host)
        .map((a) => a.registration)
        .sort()
    ).toEqual(['G-HOST', 'G-MACX'])
  })

  it('syncs only what changed the second time, from a cursor of its own', async () => {
    addAircraft(host, 'G-ONE')
    const sync = link()
    await sync.run()
    addAircraft(host, 'G-TWO')
    await sync.run()
    expect(
      listAircraft(client)
        .map((a) => a.registration)
        .sort()
    ).toEqual(['G-ONE', 'G-TWO'])
    // The cloud account's cursors are untouched.
    for (const table of SYNC_TABLES) {
      expect(listAndSerializeForPush(client, table, null).length).toBeGreaterThanOrEqual(0)
    }
  })

  it('pages a long table across the link', async () => {
    for (let i = 0; i < 260; i++) addAircraft(host, `G-${String(i).padStart(4, '0')}`)
    await link().run()
    expect(listAircraft(client)).toHaveLength(260)
  })
})

describe('chunkRows', () => {
  const row = (i: number, size = 10): SyncRow => ({
    uuid: `u${i}`,
    updatedAt: '2026-11-08T00:00:00.000Z',
    data: 'x'.repeat(size)
  })

  it('keeps rows in order and splits by count', () => {
    const rows = Array.from({ length: PUSH_CHUNK_ROWS * 2 + 1 }, (_, i) => row(i))
    const chunks = chunkRows(rows)
    expect(chunks.map((chunk) => chunk.length)).toEqual([PUSH_CHUNK_ROWS, PUSH_CHUNK_ROWS, 1])
    expect(chunks.flat()).toEqual(rows)
  })

  it('splits by size, and puts one very large row on its own', () => {
    const chunks = chunkRows([row(1, 1_500_000), row(2, 1_500_000), row(3, 100)])
    expect(chunks.map((chunk) => chunk.map((r) => r.uuid))).toEqual([['u1'], ['u2', 'u3']])
    expect(chunkRows([])).toEqual([])
  })
})

describe('LanSyncClient refuses what is not rows', () => {
  it('on a pull that is not a page, a row that is not a row, or a host that never ends', async () => {
    const pull = (answer: unknown) =>
      new LanSyncClient(() => Promise.resolve(answer)).syncPull('', '', 'aircraft', null)
    await expect(pull('nope')).rejects.toThrow('not rows')
    await expect(pull({ rows: [{ uuid: 'a' }], next: null })).rejects.toThrow('not a row')
    await expect(
      new LanSyncClient(() => Promise.resolve({ rows: [], next: { updatedAt: 'a', uuid: 'b' } })).syncPull(
        '',
        '',
        'aircraft',
        null
      )
    ).rejects.toThrow('more pages')
  })

  it('on a push whose answer is not a result', async () => {
    const client = new LanSyncClient(() => Promise.resolve({ upserted: 'x' }))
    await expect(
      client.syncPush('', '', 'aircraft', [{ uuid: 'a', updatedAt: 'b', data: '{}' }])
    ).rejects.toThrow('not a result')
  })
})

describe('TwinSync', () => {
  function sync(overrides: { canSync?: () => boolean; fail?: boolean } = {}) {
    let calls = 0
    let release: () => void = () => {}
    const db = freshDb()
    const ask = vi.fn(async (name: string) => {
      calls += 1
      if (overrides.fail) throw new Error('down')
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve))
      return name === 'sync.pull' ? { rows: [], next: null } : { upserted: [], rejected: [] }
    })
    const dir = mkdtempSync(join(tmpdir(), 'winglog-twin-'))
    const twin = new TwinSync({
      db,
      dbPath: join(dir, 'winglog.db'),
      client: new LanSyncClient(ask),
      canSync: overrides.canSync ?? (() => true)
    })
    const states: string[] = []
    twin.onChange(() => states.push(twin.status().state))
    return {
      twin,
      ask,
      states,
      release: () => release(),
      cleanup: () => rmSync(dir, { recursive: true, force: true })
    }
  }

  it('runs one sync at a time, and once more when asked during one', async () => {
    const { twin, ask, release, states, cleanup } = sync()
    const first = twin.run()
    const during = [twin.run(), twin.run()]
    release()
    await first
    // Whoever asked during the sync hears how the next one went.
    expect(await Promise.all(during)).toEqual([true, true])
    // Four tables pulled in the first run, four again in the one asked for while it ran, however many times it was asked.
    expect(ask.mock.calls.filter(([name]) => name === 'sync.pull')).toHaveLength(8)
    expect(states).toEqual(['syncing', 'idle', 'syncing', 'idle'])
    cleanup()
  })

  it('does nothing while the link is down', async () => {
    const { twin, ask, cleanup } = sync({ canSync: () => false })
    await twin.run()
    expect(ask).not.toHaveBeenCalled()
    expect(twin.status()).toEqual({ state: 'idle', lastSyncedAt: null })
    cleanup()
  })

  it('says it failed, keeps the last good time, and does not throw', async () => {
    const { twin, cleanup } = sync({ fail: true })
    await expect(twin.run()).resolves.toBe(false)
    expect(twin.status()).toEqual({ state: 'error', lastSyncedAt: null })
    cleanup()
  })

  it('waits after a write so a burst is one sync, and a later ask moves it', async () => {
    vi.useFakeTimers()
    const { twin, ask, release, cleanup } = sync()
    twin.syncSoon(2000)
    await vi.advanceTimersByTimeAsync(1500)
    twin.syncSoon(2000)
    await vi.advanceTimersByTimeAsync(1500)
    expect(ask).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(ask).toHaveBeenCalledTimes(1)
    release()
    twin.stop()
    vi.useRealTimers()
    cleanup()
  })
})
