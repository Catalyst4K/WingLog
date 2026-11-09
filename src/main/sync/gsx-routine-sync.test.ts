import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { deleteOwnRoutine, listHiddenBuiltIns, listOwnRoutines, saveOwnRoutine } from '../db/gsx-routine-repo'
import { LanSyncClient } from '../host-link/lan-sync-client'
import { twinSyncDeviceQueries, twinSyncQueries } from '../lan/twin-sync'
import type { GsxRoutine } from '@shared/gsx-routines'
import { runCursorSync } from './cursor-sync'
import { applyPulledRow } from './sync-engine'

vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const ROUTINE: GsxRoutine = {
  id: 'cabin-turn',
  name: 'Cabin turn',
  stages: [{ services: ['Cleaning', 'Water'], startsWhen: [] }],
  answerGsxChoice: true,
  fuel: 'ask'
}

const row = (uuid: string, fields: Record<string, unknown>, updatedAt = '2026-11-09T10:00:00.000Z') => ({
  uuid,
  updatedAt,
  data: JSON.stringify({ deletedAt: null, ...fields })
})

function freshDb(): WingLogDb {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

describe('a GSX routine row arriving from another computer', () => {
  let db: WingLogDb
  beforeEach(() => {
    db = freshDb()
  })

  it('is stored when it is a valid routine under its own id', () => {
    const result = applyPulledRow(
      db,
      'gsxRoutine',
      row('cabin-turn', { kind: 'routine', data: JSON.stringify(ROUTINE) })
    )
    expect(result).toEqual({ ok: true, applied: true, uuid: 'cabin-turn' })
    expect(listOwnRoutines(db).routines).toEqual([ROUTINE])
  })

  it('is refused, and never run, when the routine is not valid', () => {
    const bad = { ...ROUTINE, stages: [{ services: ['Departure'], startsWhen: [] }] }
    const result = applyPulledRow(
      db,
      'gsxRoutine',
      row('cabin-turn', { kind: 'routine', data: JSON.stringify(bad) })
    )
    expect(result).toMatchObject({ ok: false })
    expect(listOwnRoutines(db).routines).toEqual([])
  })

  it('is refused when its key is not the routine’s own id, so a row cannot stand in for another routine', () => {
    const result = applyPulledRow(
      db,
      'gsxRoutine',
      row('someone-elses', { kind: 'routine', data: JSON.stringify(ROUTINE) })
    )
    expect(result).toEqual({ ok: false, error: 'the routine id is not the row key' })
  })

  it('is refused when it is malformed: not JSON, the wrong kind, no data, a long deleted time', () => {
    expect(applyPulledRow(db, 'gsxRoutine', { uuid: 'x', updatedAt: 't', data: 'nope' })).toMatchObject({
      ok: false
    })
    expect(applyPulledRow(db, 'gsxRoutine', row('x', { kind: 'other', data: '{}' }))).toMatchObject({
      ok: false
    })
    expect(applyPulledRow(db, 'gsxRoutine', row('x', { kind: 'routine' }))).toMatchObject({ ok: false })
    expect(
      applyPulledRow(db, 'gsxRoutine', row('cabin-turn', { kind: 'routine', data: '{broken' }))
    ).toMatchObject({ ok: false })
    expect(
      applyPulledRow(
        db,
        'gsxRoutine',
        row('cabin-turn', { kind: 'routine', data: '{}', deletedAt: 'x'.repeat(100) })
      )
    ).toMatchObject({ ok: false })
  })

  it('removes a routine when it arrives as deleted, without needing the routine itself to be valid', () => {
    saveOwnRoutine(db, ROUTINE)
    const newer = row(
      'cabin-turn',
      { kind: 'routine', data: '{}', deletedAt: '2099-01-01T00:00:00.000Z' },
      '2099-01-01T00:00:00.000Z'
    )
    expect(applyPulledRow(db, 'gsxRoutine', newer)).toMatchObject({ ok: true, applied: true })
    expect(listOwnRoutines(db).routines).toEqual([])
  })

  it('hides a built-in only for a built-in’s own mark, and refuses a mark for anything else', () => {
    expect(
      applyPulledRow(db, 'gsxRoutine', row('hidden-builtin-arrival', { kind: 'hidden', data: '{}' }))
    ).toMatchObject({ ok: true })
    expect(listHiddenBuiltIns(db)).toEqual(['builtin-arrival'])
    expect(
      applyPulledRow(db, 'gsxRoutine', row('hidden-my-routine', { kind: 'hidden', data: '{}' }))
    ).toMatchObject({ ok: false })
  })

  it('does not replace this computer’s newer version of the routine', () => {
    saveOwnRoutine(db, { ...ROUTINE, name: 'Edited here' })
    const older = row(
      'cabin-turn',
      { kind: 'routine', data: JSON.stringify({ ...ROUTINE, name: 'Old' }) },
      '2020-01-01T00:00:00.000Z'
    )
    expect(applyPulledRow(db, 'gsxRoutine', older)).toMatchObject({ ok: true, applied: false })
    expect(listOwnRoutines(db).routines.map((r) => r.name)).toEqual(['Edited here'])
  })

  it('drops fields a routine does not have, so a row cannot carry extra data in', () => {
    const sneaky = { ...ROUTINE, run: 'rm -rf', extra: { a: 1 } }
    applyPulledRow(db, 'gsxRoutine', row('cabin-turn', { kind: 'routine', data: JSON.stringify(sneaky) }))
    expect(listOwnRoutines(db).routines).toEqual([ROUTINE])
  })
})

describe('GSX routines between two computers, through the real sync', () => {
  let host: WingLogDb
  let client: WingLogDb
  let dir: string

  beforeEach(() => {
    host = freshDb()
    client = freshDb()
    dir = mkdtempSync(join(tmpdir(), 'winglog-gsx-sync-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** The client syncs with the host, as it does on the link, through JSON as the socket would. */
  async function sync(): Promise<void> {
    const queries = twinSyncQueries(host)
    const device = twinSyncDeviceQueries(host, join(dir, 'host.db'))
    const ask = async (name: string, ...args: unknown[]): Promise<unknown> => {
      const sent = JSON.parse(JSON.stringify(args)) as unknown[]
      const answer = device[name] ? device[name](1, ...sent) : queries[name](...sent)
      return JSON.parse(JSON.stringify(await answer))
    }
    await runCursorSync(
      client,
      new LanSyncClient(ask),
      { email: 'twin', token: '' },
      join(dir, 'client.db'),
      'host'
    )
  }

  it('carries a routine made on the client to the host, an edit back, and a deletion both ways', async () => {
    saveOwnRoutine(client, ROUTINE)
    await sync()
    expect(listOwnRoutines(host).routines).toEqual([ROUTINE])

    // Edited on the host later: the client takes the new version.
    const edited = { ...ROUTINE, name: 'Edited on the PC' }
    await new Promise((resolve) => setTimeout(resolve, 5))
    saveOwnRoutine(host, edited)
    await sync()
    expect(listOwnRoutines(client).routines).toEqual([edited])

    // Deleted on the client: gone from the host too, and a built-in deleted on the host is hidden on the client.
    await new Promise((resolve) => setTimeout(resolve, 5))
    deleteOwnRoutine(client, 'cabin-turn')
    deleteOwnRoutine(host, 'builtin-arrival')
    await sync()
    expect(listOwnRoutines(host).routines).toEqual([])
    expect(listHiddenBuiltIns(client)).toEqual(['builtin-arrival'])
  })

  it('keeps the later edit when the same routine was edited on both', async () => {
    saveOwnRoutine(host, ROUTINE)
    await sync()
    await new Promise((resolve) => setTimeout(resolve, 5))
    saveOwnRoutine(client, { ...ROUTINE, name: 'Client edit' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    saveOwnRoutine(host, { ...ROUTINE, name: 'Host edit, later' })
    await sync()
    await sync()
    expect(listOwnRoutines(host).routines.map((r) => r.name)).toEqual(['Host edit, later'])
    expect(listOwnRoutines(client).routines.map((r) => r.name)).toEqual(['Host edit, later'])
  })
})
