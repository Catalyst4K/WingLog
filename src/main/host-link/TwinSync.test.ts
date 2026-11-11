import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft, listAircraft } from '../db/aircraft-repo'
import type { SyncRow } from '../backend/sync-client'
import { getPullCursor, getPushCursor } from '../db/sync-change-repo'
import { twinSyncDeviceQueries, twinSyncQueries } from '../lan/twin-sync'
import { localSyncVersion } from '../sync/sync-version'
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
  let asked: { name: string; args: unknown[] }[]

  beforeEach(() => {
    host = freshDb()
    client = freshDb()
    dir = mkdtempSync(join(tmpdir(), 'winglog-twin-'))
    asked = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A link in which the client asks the host's own lookups, through JSON as the socket would; the host knows this client as device 1. */
  function link(): TwinSync {
    const queries = twinSyncQueries(host)
    const deviceQueries = twinSyncDeviceQueries(host, join(dir, 'host.db'))
    const ask = (name: string, ...args: unknown[]): Promise<unknown> => {
      const sent = JSON.parse(JSON.stringify(args)) as unknown[]
      asked.push({ name, args: sent })
      const answer = deviceQueries[name] ? deviceQueries[name](1, ...sent) : queries[name](...sent)
      // A lookup may answer later (a push is applied a few rows at a time).
      return Promise.resolve(answer).then((value) => JSON.parse(JSON.stringify(value)))
    }
    return new TwinSync({
      db: client,
      dbPath: join(dir, 'client.db'),
      client: new LanSyncClient(ask),
      canSync: () => true
    })
  }

  const addAircraft = (db: WingLogDb, registration: string): void => {
    createAircraft(db, { registration, icaoType: 'A320' })
  }
  const registrations = (db: WingLogDb): string[] =>
    listAircraft(db)
      .map((a) => a.registration)
      .sort()

  it('brings a new client level with the host, and the host with what the client made', async () => {
    addAircraft(host, 'G-HOST')
    addAircraft(client, 'G-MACX')
    const sync = link()
    await sync.run()
    expect(sync.status().state).toBe('idle')
    expect(sync.status().lastSyncedAt).not.toBeNull()
    expect(registrations(client)).toEqual(['G-HOST', 'G-MACX'])
    expect(registrations(host)).toEqual(['G-HOST', 'G-MACX'])
  })

  it('syncs only what changed the second time, from cursors of its own', async () => {
    addAircraft(host, 'G-ONE')
    const sync = link()
    await sync.run()
    const firstCursor = getPullCursor(client, 'host', 'aircraft')
    expect(firstCursor).toBeGreaterThan(0)
    addAircraft(host, 'G-TWO')
    asked.length = 0
    await sync.run()
    expect(registrations(client)).toEqual(['G-ONE', 'G-TWO'])
    expect(asked.find((a) => a.name === 'sync.pull' && a.args[0] === 'aircraft')?.args[1]).toBe(firstCursor)
    // The cloud account's cursors are untouched, and the host's rows were not sent back to it.
    expect(getPullCursor(client, 'cloud', 'aircraft')).toBeNull()
    expect(getPushCursor(client, 'cloud', 'aircraft')).toBe(0)
    expect(asked.filter((a) => a.name === 'sync.push')).toEqual([])
  })

  it('sends a new sim PC database everything when the twin pairs again, and forgets nothing it has not been asked to (audit M8)', async () => {
    addAircraft(host, 'G-HOST')
    addAircraft(client, 'G-MACX')
    const first = link()
    await first.run()
    await first.run()
    expect(getPullCursor(client, 'host', 'aircraft')).toBeGreaterThan(0)
    expect(getPushCursor(client, 'host', 'aircraft')).toBeGreaterThan(0)

    // Pairing again, or forgetting the sim PC, drops the cursors kept for the old one.
    first.forgetCursors()
    expect(getPullCursor(client, 'host', 'aircraft')).toBeNull()
    expect(getPushCursor(client, 'host', 'aircraft')).toBe(0)
    // The cloud account's cursors are not the sim PC's to drop.
    expect(getPullCursor(client, 'cloud', 'aircraft')).toBeNull()

    // The sim PC now keeps a new, empty database: the twin sends it every row.
    host = freshDb()
    await link().run()
    // G-HOST came from the old sim PC, so it is not sent back to a sim PC; G-MACX was made here and is.
    expect(registrations(host)).toEqual(['G-MACX'])
  })

  it('also starts the sim PC again on its own when its database is new and the cursors were kept (no pairing between)', async () => {
    addAircraft(client, 'G-MACX')
    addAircraft(client, 'G-MACY')
    addAircraft(client, 'G-MACZ')
    const first = link()
    await first.run()
    await first.run()
    expect(registrations(host)).toEqual(['G-MACX', 'G-MACY', 'G-MACZ'])

    // A restored or new database on the sim PC, with a counter that starts low.
    host = freshDb()
    addAircraft(host, 'G-NEWH')
    await link().run()

    expect(registrations(host)).toEqual(['G-MACX', 'G-MACY', 'G-MACZ', 'G-NEWH'])
    expect(registrations(client)).toEqual(['G-MACX', 'G-MACY', 'G-MACZ', 'G-NEWH'])
  })

  it('pages a long table across the link', async () => {
    for (let i = 0; i < 260; i++) addAircraft(host, `G-${String(i).padStart(4, '0')}`)
    await link().run()
    expect(listAircraft(client)).toHaveLength(260)
  })

  it('does not hand a client back the rows it pushed, but hands them to another', async () => {
    addAircraft(client, 'G-MACX')
    await link().run()
    expect(registrations(host)).toEqual(['G-MACX'])
    // The host gives device 1 nothing it did not already have; device 2 would be given the Mac's row.
    const deviceQueries = twinSyncDeviceQueries(host, join(dir, 'host.db'))
    const page = (device: number) =>
      deviceQueries['sync.pull'](device, 'aircraft', null) as { rows: SyncRow[] }
    expect(page(1).rows).toEqual([])
    expect(page(2).rows).toHaveLength(1)
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
  const pull = (answer: unknown) =>
    new LanSyncClient(() => Promise.resolve(answer)).syncPullPage('', '', 'aircraft', null)

  it('on a pull that is not a page, a row that is not a row, or a cursor that is not a counter', async () => {
    await expect(pull('nope')).rejects.toThrow('not rows')
    await expect(pull({ rows: [{ uuid: 'a' }], cursor: 1, more: false })).rejects.toThrow('not a row')
    for (const bad of [
      { rows: [], more: false },
      { rows: [], cursor: -1, more: false },
      { rows: [], cursor: 1 }
    ]) {
      await expect(pull(bad)).rejects.toThrow('not rows')
    }
    for (const head of [-1, 1.5, '3', null]) {
      await expect(pull({ rows: [], cursor: 3, more: true, head })).rejects.toThrow('not rows')
    }
    await expect(pull({ rows: [], cursor: 3, more: false, head: 7 })).resolves.toEqual({
      rows: [],
      cursor: 3,
      more: false,
      head: 7
    })
    await expect(pull({ rows: [], cursor: 3, more: true })).resolves.toEqual({
      rows: [],
      cursor: 3,
      more: true
    })
  })

  it('on a push whose answer is not a result', async () => {
    const client = new LanSyncClient(() => Promise.resolve({ upserted: 'x' }))
    await expect(
      client.syncPush('', '', 'aircraft', [{ uuid: 'a', updatedAt: 'b', data: '{}' }])
    ).rejects.toThrow('not a result')
  })

  it('on a version that is not a version', async () => {
    await expect(new LanSyncClient(() => Promise.resolve({ protocol: 'x' })).version()).rejects.toThrow(
      'not a version'
    )
    await expect(
      new LanSyncClient(() => Promise.resolve({ protocol: 2, schema: 44 })).version()
    ).resolves.toEqual({
      protocol: 2,
      schema: 44
    })
  })
})

describe('TwinSync', () => {
  function sync(
    overrides: {
      canSync?: () => boolean
      fail?: boolean
      hostVersion?: { protocol: number; schema: number }
      afterSync?: () => Promise<unknown>
    } = {}
  ) {
    let calls = 0
    let release: () => void = () => {}
    const db = freshDb()
    const ask = vi.fn(async (name: string) => {
      calls += 1
      if (overrides.fail) throw new Error('down')
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve))
      if (name === 'sync.version') return overrides.hostVersion ?? localSyncVersion(db)
      return name === 'sync.pull' ? { rows: [], cursor: 0, more: false } : { upserted: [], rejected: [] }
    })
    const dir = mkdtempSync(join(tmpdir(), 'winglog-twin-'))
    const twin = new TwinSync({
      db,
      dbPath: join(dir, 'winglog.db'),
      client: new LanSyncClient(ask),
      canSync: overrides.canSync ?? (() => true),
      afterSync: overrides.afterSync
    })
    const states: string[] = []
    twin.onChange(() => states.push(twin.status().state))
    return {
      twin,
      ask,
      states,
      db,
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
    // Five tables pulled in the first run, five again in the one asked for while it ran, however many times it was asked.
    expect(ask.mock.calls.filter(([name]) => name === 'sync.pull')).toHaveLength(10)
    expect(states).toEqual(['syncing', 'idle', 'syncing', 'idle'])
    cleanup()
  })

  it('does nothing while the link is down', async () => {
    const { twin, ask, cleanup } = sync({ canSync: () => false })
    await twin.run()
    expect(ask).not.toHaveBeenCalled()
    expect(twin.status()).toEqual({ state: 'idle', lastSyncedAt: null, problem: null })
    cleanup()
  })

  it('says it failed, keeps the last good time, and does not throw', async () => {
    const { twin, cleanup } = sync({ fail: true })
    await expect(twin.run()).resolves.toBe(false)
    expect(twin.status()).toEqual({ state: 'error', lastSyncedAt: null, problem: null })
    cleanup()
  })

  it.each([
    ['an older sim PC', -1, 'update-sim-pc'],
    ['a newer sim PC', 1, 'update-this-computer']
  ] as const)('does not sync with %s, and says which computer to update', async (_name, offset, problem) => {
    const local = localSyncVersion(freshDb())
    const { twin, ask, release, cleanup } = sync({
      hostVersion: { protocol: local.protocol, schema: local.schema + offset }
    })
    const done = twin.run()
    release()
    await expect(done).resolves.toBe(false)
    expect(twin.status()).toEqual({ state: 'error', lastSyncedAt: null, problem })
    expect(ask.mock.calls.map(([name]) => name)).toEqual(['sync.version'])
    cleanup()
  })

  it('names the protocol as the thing to update when that is what differs', async () => {
    const local = localSyncVersion(freshDb())
    const { twin, release, cleanup } = sync({
      hostVersion: { protocol: local.protocol + 1, schema: local.schema }
    })
    const done = twin.run()
    release()
    await done
    expect(twin.status().problem).toBe('update-this-computer')
    cleanup()
  })

  it('clears the problem when the next sync finds the versions level', async () => {
    const { twin, release, cleanup } = sync()
    const done = twin.run()
    release()
    await done
    expect(twin.status()).toMatchObject({ state: 'idle', problem: null })
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
  describe('answers that are not objects at all', () => {
    it('a page whose row is null, and a version that is null or text', async () => {
      const pull = new LanSyncClient(() => Promise.resolve({ rows: [null], cursor: 1, more: false }))
      await expect(pull.syncPullPage('', '', 'aircraft', null)).rejects.toThrow('not a row')
      for (const answer of [null, 'v2']) {
        await expect(new LanSyncClient(() => Promise.resolve(answer)).version()).rejects.toThrow(
          'not a version'
        )
      }
    })
  })
  it('stops a sync that is waiting to start', async () => {
    vi.useFakeTimers()
    const { twin, ask, cleanup } = sync()
    twin.syncSoon(2000)
    twin.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ask).not.toHaveBeenCalled()
    vi.useRealTimers()
    cleanup()
  })

  it('does not hold the sync back for the tracks of completed flights, and brings them one pass at a time', async () => {
    let finishTracks: () => void = () => {}
    const afterSync = vi.fn(() => new Promise<void>((resolve) => (finishTracks = resolve)))
    const { twin, release, cleanup } = sync({ afterSync })
    const first = twin.run()
    release()
    // The sync is over, and whoever waited for it (Fly) is released, while the tracks are still coming.
    await expect(first).resolves.toBe(true)
    expect(afterSync).toHaveBeenCalledTimes(1)
    expect(twin.status().state).toBe('idle')
    // Another sync while the tracks are still coming does not start a second pass.
    await twin.run()
    expect(afterSync).toHaveBeenCalledTimes(1)
    finishTracks()
    await new Promise((resolve) => setImmediate(resolve))
    await twin.run()
    expect(afterSync).toHaveBeenCalledTimes(2)
    cleanup()
  })

  it('counts the sync as good even when bringing the tracks of completed flights fails afterwards', async () => {
    const { twin, release, cleanup } = sync({ afterSync: () => Promise.reject(new Error('tracks')) })
    const done = twin.run()
    release()
    await expect(done).resolves.toBe(true)
    expect(twin.status().state).toBe('idle')
    cleanup()
  })
})
