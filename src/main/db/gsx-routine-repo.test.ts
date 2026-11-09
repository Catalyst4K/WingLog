import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { createDb, type WingLogDb } from './client'
import {
  deleteOwnRoutine,
  getGsxRoutineByUuid,
  listHiddenBuiltIns,
  listOwnRoutines,
  saveOwnRoutine,
  upsertGsxRoutineByUuid
} from './gsx-routine-repo'
import { gsxRoutine, syncChange } from './schema'
import type { GsxRoutine } from '@shared/gsx-routines'

const MY_ROUTINE: GsxRoutine = {
  id: 'my-routine',
  name: 'Cabin turn',
  stages: [{ services: ['Cleaning', 'Water'], startsWhen: [] }],
  answerGsxChoice: true,
  fuel: 'ask'
}

describe('GSX routines, one row each', () => {
  let db: WingLogDb

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
  })

  it('has none until the pilot saves one, and nothing deleted', () => {
    expect(listOwnRoutines(db)).toEqual({ routines: [], problem: null })
    expect(listHiddenBuiltIns(db)).toEqual([])
  })

  it('keeps what was saved, replaces it when saved again, and counts each change for sync', () => {
    saveOwnRoutine(db, MY_ROUTINE)
    saveOwnRoutine(db, { ...MY_ROUTINE, name: 'Renamed' })
    expect(listOwnRoutines(db).routines).toEqual([{ ...MY_ROUTINE, name: 'Renamed' }])
    expect(db.select().from(gsxRoutine).all()).toHaveLength(1)
    expect(
      db
        .select()
        .from(syncChange)
        .where(eq(syncChange.tableName, 'gsxRoutine'))
        .all()
        .map((r) => r.uuid)
    ).toEqual(['my-routine'])
  })

  it('keeps the routines in the order they were first made', () => {
    saveOwnRoutine(db, { ...MY_ROUTINE, id: 'b-second' })
    saveOwnRoutine(db, { ...MY_ROUTINE, id: 'a-first' })
    saveOwnRoutine(db, { ...MY_ROUTINE, id: 'b-second', name: 'Edited' })
    expect(listOwnRoutines(db).routines.map((r) => r.id)).toEqual(['b-second', 'a-first'])
  })

  it('deleting a routine keeps its row, marked deleted, so the deletion reaches the other computers', () => {
    saveOwnRoutine(db, MY_ROUTINE)
    deleteOwnRoutine(db, 'my-routine')
    expect(listOwnRoutines(db).routines).toEqual([])
    expect(getGsxRoutineByUuid(db, 'my-routine')?.deletedAt).not.toBeNull()
    // Saving it again brings it back.
    saveOwnRoutine(db, MY_ROUTINE)
    expect(listOwnRoutines(db).routines).toEqual([MY_ROUTINE])
    expect(getGsxRoutineByUuid(db, 'my-routine')?.deletedAt).toBeNull()
  })

  it('deleting a built-in hides it and drops the pilot’s version of it; deleting an unknown id changes nothing', () => {
    saveOwnRoutine(db, { ...MY_ROUTINE, id: 'builtin-arrival', name: 'My arrival' })
    deleteOwnRoutine(db, 'builtin-arrival')
    deleteOwnRoutine(db, 'builtin-arrival')
    deleteOwnRoutine(db, 'no-such-routine')
    expect(listOwnRoutines(db).routines).toEqual([])
    expect(listHiddenBuiltIns(db)).toEqual(['builtin-arrival'])
    expect(
      db
        .select()
        .from(gsxRoutine)
        .all()
        .map((r) => r.uuid)
        .sort()
    ).toEqual(['builtin-arrival', 'hidden-builtin-arrival'])
  })

  it('leaves out a row that is not a valid routine and says why, instead of failing', () => {
    saveOwnRoutine(db, MY_ROUTINE)
    db.insert(gsxRoutine)
      .values({
        uuid: 'broken',
        kind: 'routine',
        data: '{"id":"broken"}',
        updatedAt: '2026-11-09T00:00:00.000Z'
      })
      .run()
    const read = listOwnRoutines(db)
    expect(read.routines).toEqual([MY_ROUTINE])
    expect(read.problem).toMatch(/dropped 1/)
  })

  describe('applying a row from another computer', () => {
    const row = (updatedAt: string, name: string) => ({
      uuid: 'my-routine',
      kind: 'routine' as const,
      data: JSON.stringify({ ...MY_ROUTINE, name }),
      deletedAt: null,
      updatedAt
    })

    it('takes a new row, takes a newer one, and keeps this computer’s own when it is as new or newer', () => {
      expect(upsertGsxRoutineByUuid(db, row('2026-11-09T10:00:00.000Z', 'First'))).toBe(true)
      expect(upsertGsxRoutineByUuid(db, row('2026-11-09T11:00:00.000Z', 'Newer'))).toBe(true)
      expect(upsertGsxRoutineByUuid(db, row('2026-11-09T09:00:00.000Z', 'Older'))).toBe(false)
      expect(upsertGsxRoutineByUuid(db, row('2026-11-09T11:00:00.000Z', 'Same time'))).toBe(false)
      expect(listOwnRoutines(db).routines.map((r) => r.name)).toEqual(['Newer'])
    })
  })
})
