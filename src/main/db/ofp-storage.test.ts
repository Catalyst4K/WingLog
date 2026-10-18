import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createAircraft } from './aircraft-repo'
import { createDb, type WingLogDbHandle } from './client'
import {
  createFlight,
  getFlight,
  listCompletedFlights,
  listFlightsForSync,
  upsertFlightByUuid
} from './flight-repo'
import { compressStoredOfps, reclaimFreeSpace } from './ofp-storage'

/** Something shaped like a SimBrief OFP, sized in fixes. */
function ofp(fixes: number, tag = 'a'): string {
  return JSON.stringify({
    tag,
    navlog: {
      fix: Array.from({ length: fixes }, (_, i) => ({
        ident: `FIX${i}`,
        pos_lat: `${45 + i / 1000}`,
        via_airway: 'UL9'
      }))
    }
  })
}

describe('OFP storage', () => {
  let dir: string
  let handle: WingLogDbHandle
  let aircraftId: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-ofp-'))
    handle = createDb(join(dir, 'winglog.db'))
    migrate(handle.db, { migrationsFolder: 'drizzle' })
    aircraftId = createAircraft(handle.db, { registration: 'G-ABCD', icaoType: 'A320' }).id
  })
  afterEach(() => {
    handle.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** What SQLite holds in the OFP column of a flight. */
  const storedType = (id: number): string =>
    (handle.sqlite.prepare('SELECT typeof(ofp_json) AS t FROM flight WHERE id = ?').get(id) as { t: string })
      .t

  /** A flight as an older version stored it: the OFP as plain text. */
  function legacyFlight(text: string | null): number {
    const id = createFlight(handle.db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC' }).id
    handle.sqlite.prepare('UPDATE flight SET ofp_json = ? WHERE id = ?').run(text, id)
    return id
  }

  describe('through the repo', () => {
    it('stores a new flight’s OFP compressed, and reads it back as the same string', () => {
      const text = ofp(400)
      const flight = createFlight(handle.db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC', ofpJson: text })
      expect(storedType(flight.id)).toBe('blob')
      expect(getFlight(handle.db, flight.id)?.ofpJson).toBe(text)
      const stored = (
        handle.sqlite.prepare('SELECT length(ofp_json) AS n FROM flight WHERE id = ?').get(flight.id) as {
          n: number
        }
      ).n
      expect(stored * 5).toBeLessThan(Buffer.byteLength(text, 'utf8'))
    })

    it('still reads a flight stored as plain text before this change', () => {
      const id = legacyFlight(ofp(50))
      expect(storedType(id)).toBe('text')
      expect(getFlight(handle.db, id)?.ofpJson).toBe(ofp(50))
    })

    it('keeps a flight with no OFP null, and the Logbook still knows which flights have one', () => {
      const none = legacyFlight(null)
      const compressed = createFlight(handle.db, {
        aircraftId,
        depIcao: 'EGLL',
        arrIcao: 'EGCC',
        ofpJson: ofp(10)
      }).id
      handle.sqlite.prepare("UPDATE flight SET status = 'completed'").run()
      expect(getFlight(handle.db, none)?.ofpJson).toBeNull()
      const hasOfp = new Map(listCompletedFlights(handle.db).map((f) => [f.id, f.hasOfp]))
      expect(hasOfp.get(none)).toBe(false)
      expect(hasOfp.get(compressed)).toBe(true)
    })

    it('hands sync and export the OFP as text, and compresses what sync writes', () => {
      const text = ofp(30, 'sync')
      const flight = createFlight(handle.db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC', ofpJson: text })
      expect(listFlightsForSync(handle.db, null).find((r) => r.id === flight.id)?.ofpJson).toBe(text)
      // A flight pulled from another device arrives as text and is stored compressed.
      const pulled = ofp(25, 'pulled')
      expect(
        upsertFlightByUuid(handle.db, {
          uuid: 'remote-flight-1',
          aircraftId,
          depIcao: 'EGLL',
          arrIcao: 'EGCC',
          status: 'completed',
          ofpJson: pulled,
          updatedAt: '2026-10-01T10:00:00.000Z'
        })
      ).toBe(true)
      const row = handle.sqlite.prepare("SELECT id FROM flight WHERE uuid = 'remote-flight-1'").get() as {
        id: number
      }
      expect(storedType(row.id)).toBe('blob')
      expect(getFlight(handle.db, row.id)?.ofpJson).toBe(pulled)
    })
  })

  describe('compressStoredOfps', () => {
    it('converts every plain-text OFP, changes nothing about the flight, and reads back identically', async () => {
      const texts = [ofp(300, 'one'), ofp(500, 'two'), ofp(20, 'three')]
      const ids = texts.map((t) => legacyFlight(t))
      const empty = legacyFlight(null)
      handle.sqlite.prepare("UPDATE flight SET updated_at = '2026-01-01T00:00:00.000Z'").run()
      const before = handle.sqlite
        .prepare('SELECT id, updated_at, status, dep_icao FROM flight ORDER BY id')
        .all()

      const result = await compressStoredOfps(handle.sqlite)

      expect(result).toMatchObject({ converted: 3, skipped: 0 })
      expect(result.bytesAfter).toBeLessThan(result.bytesBefore)
      ids.forEach((id, i) => {
        expect(storedType(id)).toBe('blob')
        expect(getFlight(handle.db, id)?.ofpJson).toBe(texts[i])
      })
      expect(storedType(empty)).toBe('null')
      expect(
        handle.sqlite.prepare('SELECT id, updated_at, status, dep_icao FROM flight ORDER BY id').all()
      ).toEqual(before)
    })

    it('is safe to run again: a second pass converts nothing', async () => {
      legacyFlight(ofp(100))
      expect((await compressStoredOfps(handle.sqlite)).converted).toBe(1)
      expect(await compressStoredOfps(handle.sqlite)).toEqual({
        converted: 0,
        skipped: 0,
        bytesBefore: 0,
        bytesAfter: 0
      })
    })

    it('leaves a flight whose OFP the app compressed itself alone', async () => {
      const text = ofp(40, 'native')
      const id = createFlight(handle.db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC', ofpJson: text }).id
      expect((await compressStoredOfps(handle.sqlite)).converted).toBe(0)
      expect(getFlight(handle.db, id)?.ofpJson).toBe(text)
    })

    it('keeps the foreign-key rows and the integrity of the database', async () => {
      legacyFlight(ofp(100))
      await compressStoredOfps(handle.sqlite)
      expect(handle.sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(handle.sqlite.pragma('foreign_key_check')).toEqual([])
    })
  })

  describe('reclaimFreeSpace', () => {
    /** Enough large plain-text OFPs that converting them leaves most of the file free. */
    async function fillAndConvert(): Promise<void> {
      for (let i = 0; i < 12; i++) legacyFlight(ofp(40_000, String(i)))
      await compressStoredOfps(handle.sqlite)
    }

    it('shrinks the file after a conversion, keeps every flight readable, and the integrity check passes', async () => {
      await fillAndConvert()
      const texts = Array.from({ length: 12 }, (_, i) => ofp(40_000, String(i)))
      handle.sqlite.pragma('wal_checkpoint(TRUNCATE)')
      const sizeBefore = statSync(join(dir, 'winglog.db')).size
      const result = reclaimFreeSpace(handle.sqlite, true)
      expect(result).not.toBeNull()
      expect(result?.bytesAfter).toBeLessThan((result?.bytesBefore ?? 0) / 2)
      expect(statSync(join(dir, 'winglog.db')).size).toBeLessThan(sizeBefore / 2)
      const ids = (handle.sqlite.prepare('SELECT id FROM flight ORDER BY id').all() as { id: number }[]).map(
        (r) => r.id
      )
      ids.forEach((id, i) => expect(getFlight(handle.db, id)?.ofpJson).toBe(texts[i]))
      expect(handle.sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
    })

    it('does nothing without a backup of this launch', async () => {
      await fillAndConvert()
      expect(reclaimFreeSpace(handle.sqlite, false)).toBeNull()
    })

    it('does nothing when there is little to reclaim', () => {
      legacyFlight(ofp(100))
      expect(reclaimFreeSpace(handle.sqlite, true)).toBeNull()
    })
  })
})
