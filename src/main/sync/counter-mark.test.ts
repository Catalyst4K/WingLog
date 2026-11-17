import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { highestChangeSeq, servedEpoch } from '../db/sync-change-repo'
import { getSetting } from '../db/settings-repo'
import { counterMarkPath, raiseCounterMark, readCounterMark, reconcileCounterMark } from './counter-mark'

vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

describe('the change counter mark kept beside the database (review of 2026-11-17, finding 2)', () => {
  let db: WingLogDb
  let dir: string
  let dbPath: string

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    dir = mkdtempSync(join(tmpdir(), 'winglog-counter-mark-'))
    dbPath = join(dir, 'winglog.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const addAircraft = (registration: string): void => {
    createAircraft(db, { registration, icaoType: 'A320' })
  }
  const writeMark = (text: string): void => writeFileSync(counterMarkPath(dbPath), text)

  it('makes the mark at a first launch, and does not change the epoch', () => {
    const epoch = servedEpoch(db, 0, null)
    addAircraft('G-AAAA')

    expect(readCounterMark(dbPath)).toBeNull()
    expect(reconcileCounterMark(db, dbPath)).toBe(false)

    expect(readCounterMark(dbPath)).toBe(highestChangeSeq(db))
    expect(servedEpoch(db, 0, null)).toBe(epoch)
  })

  it('makes no epoch at a first launch of a database that has none', () => {
    expect(reconcileCounterMark(db, dbPath)).toBe(false)
    expect(getSetting(db, 'syncEpoch')).toBeUndefined()
    expect(readCounterMark(dbPath)).toBe(0)
  })

  it('raises the mark to the counter when the counter is above it, and leaves the epoch', () => {
    const epoch = servedEpoch(db, 0, null)
    writeMark(JSON.stringify({ changeSeq: 1 }))
    addAircraft('G-AAAA')
    addAircraft('G-BBBB')

    expect(reconcileCounterMark(db, dbPath)).toBe(false)

    expect(readCounterMark(dbPath)).toBe(highestChangeSeq(db))
    expect(servedEpoch(db, 0, null)).toBe(epoch)
  })

  it('gives a database whose counter is below the mark a new epoch, and the mark follows the database', () => {
    addAircraft('G-AAAA')
    const epoch = servedEpoch(db, 0, null)
    const counter = highestChangeSeq(db)
    writeMark(JSON.stringify({ changeSeq: counter + 10 }))

    expect(reconcileCounterMark(db, dbPath)).toBe(true)

    expect(getSetting(db, 'syncEpoch')).not.toBe(epoch)
    expect(readCounterMark(dbPath)).toBe(counter)
    // Launching again with no more restoring changes nothing.
    const next = getSetting(db, 'syncEpoch')
    expect(reconcileCounterMark(db, dbPath)).toBe(false)
    expect(getSetting(db, 'syncEpoch')).toBe(next)
  })

  it('treats a counter equal to the mark as nothing restored', () => {
    addAircraft('G-AAAA')
    const epoch = servedEpoch(db, 0, null)
    writeMark(JSON.stringify({ changeSeq: highestChangeSeq(db) }))

    expect(reconcileCounterMark(db, dbPath)).toBe(false)
    expect(servedEpoch(db, 0, null)).toBe(epoch)
  })

  it.each([
    ['text that is not JSON', 'not json {'],
    ['an empty file', ''],
    ['JSON that is not an object', '12'],
    ['an object with no counter', '{}'],
    ['a counter that is text', '{"changeSeq":"9"}'],
    ['a counter below zero', '{"changeSeq":-3}'],
    ['a counter that is not whole', '{"changeSeq":1.5}'],
    ['a counter too large to be exact', '{"changeSeq":1e300}'],
    ['null', 'null']
  ])('reads %s as no mark: nothing is thrown, the epoch stays, and a good mark is written', (_name, text) => {
    addAircraft('G-AAAA')
    const epoch = servedEpoch(db, 0, null)
    writeMark(text)

    expect(readCounterMark(dbPath)).toBeNull()
    expect(() => reconcileCounterMark(db, dbPath)).not.toThrow()

    expect(servedEpoch(db, 0, null)).toBe(epoch)
    expect(JSON.parse(readFileSync(counterMarkPath(dbPath), 'utf8'))).toEqual({
      changeSeq: highestChangeSeq(db)
    })
  })

  it('raises the mark only when the counter is higher, so a database put back does not lower it', () => {
    addAircraft('G-AAAA')
    raiseCounterMark(db, dbPath)
    const first = readCounterMark(dbPath)
    expect(first).toBe(highestChangeSeq(db))

    writeMark(JSON.stringify({ changeSeq: (first ?? 0) + 5 }))
    raiseCounterMark(db, dbPath)
    expect(readCounterMark(dbPath)).toBe((first ?? 0) + 5)

    addAircraft('G-BBBB')
    addAircraft('G-CCCC')
    addAircraft('G-DDDD')
    addAircraft('G-EEEE')
    addAircraft('G-FFFF')
    addAircraft('G-GGGG')
    raiseCounterMark(db, dbPath)
    expect(readCounterMark(dbPath)).toBe(highestChangeSeq(db))
  })

  it('does not throw when the file cannot be written: the sync that raised it must not fail for want of it', () => {
    const nowhere = join(dir, 'no', 'such', 'folder', 'winglog.db')
    expect(() => raiseCounterMark(db, nowhere)).not.toThrow()
    expect(() => reconcileCounterMark(db, nowhere)).not.toThrow()
    expect(readCounterMark(nowhere)).toBeNull()
  })
})
