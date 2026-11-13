import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAircraft } from './aircraft-repo'
import { createDb, type WingLogDb } from './client'
import { addInvoicesForFlight } from './flight-invoice-repo'
import { createFlight } from './flight-repo'
import { createLanding } from './landing-repo'
import { setSetting } from './settings-repo'
import { eq } from 'drizzle-orm'
import {
  clearPeerCursors,
  clearPeerOrigin,
  getKnownCounter,
  getPullCursor,
  getPushCursor,
  highestChangeSeq,
  listChangesAfter,
  localUpdatedAt,
  markOrigin,
  noteSeenFromPeer,
  servedEpoch,
  setPeerEpoch,
  setPullCursor,
  setPushCursor
} from './sync-change-repo'
import { aircraft, flight, flightInvoice, landing } from './schema'

describe('sync-change-repo', () => {
  let db: WingLogDb

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
  })

  it('keeps a pull cursor and a push cursor for each peer and table, apart', () => {
    setPullCursor(db, 'cloud', 'flight', 12)
    setPushCursor(db, 'cloud', 'flight', 7)
    setPullCursor(db, 'host', 'flight', 3)
    expect(getPullCursor(db, 'cloud', 'flight')).toBe(12)
    expect(getPushCursor(db, 'cloud', 'flight')).toBe(7)
    expect(getPullCursor(db, 'host', 'flight')).toBe(3)
    expect(getPullCursor(db, 'cloud', 'aircraft')).toBeNull()
    expect(getPushCursor(db, 'host', 'flight')).toBe(0)
  })

  it('reads a stored cursor that is not a whole number from zero as none yet, rather than trusting it', () => {
    for (const bad of ['abc', '-1', '1.5', '', 'NaN', String(Number.MAX_SAFE_INTEGER + 2)]) {
      setSetting(db, 'pullCursor:cloud:aircraft', bad)
      setSetting(db, 'pushCursor:cloud:aircraft', bad)
      expect(getPullCursor(db, 'cloud', 'aircraft')).toBeNull()
      expect(getPushCursor(db, 'cloud', 'aircraft')).toBe(0)
    }
  })

  it('forgets one peer’s cursors and no one else’s', () => {
    setPullCursor(db, 'cloud', 'flight', 12)
    setPushCursor(db, 'cloud', 'aircraft', 4)
    setPullCursor(db, 'host', 'flight', 3)
    noteSeenFromPeer(db, 'cloud', 20)
    setPeerEpoch(db, 'cloud', 'e-1')
    noteSeenFromPeer(db, 'host', 5)
    clearPeerCursors(db, 'cloud')
    expect(getPullCursor(db, 'cloud', 'flight')).toBeNull()
    expect(getPushCursor(db, 'cloud', 'aircraft')).toBe(0)
    expect(getKnownCounter(db, 'cloud')).toEqual({ seen: null, epoch: null })
    expect(getPullCursor(db, 'host', 'flight')).toBe(3)
    expect(getKnownCounter(db, 'host')).toEqual({ seen: 5, epoch: null })
  })

  it('keeps only the highest number a peer has shown (review of M8)', () => {
    expect(getKnownCounter(db, 'cloud').seen).toBeNull()
    noteSeenFromPeer(db, 'cloud', 9)
    noteSeenFromPeer(db, 'cloud', 4)
    expect(getKnownCounter(db, 'cloud').seen).toBe(9)
    noteSeenFromPeer(db, 'cloud', 10)
    expect(getKnownCounter(db, 'cloud').seen).toBe(10)
  })

  it('gives the highest number ever handed out, which a row deleted outright does not lower (review of M8)', () => {
    expect(highestChangeSeq(db)).toBe(0)
    createAircraft(db, { registration: 'G-AAAA', icaoType: 'A320' })
    createAircraft(db, { registration: 'G-BBBB', icaoType: 'A320' })
    const before = highestChangeSeq(db)
    expect(before).toBe(listChangesAfter(db, 'aircraft', 0, 10).at(-1)?.seq)
    db.delete(aircraft).where(eq(aircraft.registration, 'G-BBBB')).run()
    expect(highestChangeSeq(db)).toBe(before)
  })

  it('keeps its own epoch while no peer has seen past the head, and makes a new one when one has (review of M8)', () => {
    const first = servedEpoch(db, 0, null)
    expect(servedEpoch(db, 0, first)).toBe(first)
    createAircraft(db, { registration: 'G-AAAA', icaoType: 'A320' })
    const head = highestChangeSeq(db)
    expect(servedEpoch(db, head, first)).toBe(first)
    const second = servedEpoch(db, head + 1, first)
    expect(second).not.toBe(first)
    // A peer still on the old epoch will start again anyway: no third.
    expect(servedEpoch(db, head + 1, first)).toBe(second)
  })

  it('forgets which rows came from one peer, and no other (review of M8)', () => {
    createAircraft(db, { registration: 'G-AAAA', icaoType: 'A320' })
    createAircraft(db, { registration: 'G-BBBB', icaoType: 'A320' })
    const [a, b] = listChangesAfter(db, 'aircraft', 0, 10)
    markOrigin(db, 'aircraft', a.uuid, 'host')
    markOrigin(db, 'aircraft', b.uuid, 'cloud')
    clearPeerOrigin(db, 'host')
    expect(listChangesAfter(db, 'aircraft', 0, 10).map((c) => c.origin)).toEqual([null, 'cloud'])
  })

  it('lists a table’s changes after a number in order, limited, with where each came from', () => {
    createAircraft(db, { registration: 'G-AAAA', icaoType: 'A320' })
    createAircraft(db, { registration: 'G-BBBB', icaoType: 'A320' })
    const all = listChangesAfter(db, 'aircraft', 0, 10)
    expect(all).toHaveLength(2)
    expect(all[0].seq).toBeLessThan(all[1].seq)
    markOrigin(db, 'aircraft', all[1].uuid, 'cloud')
    expect(listChangesAfter(db, 'aircraft', all[0].seq, 10)).toEqual([{ ...all[1], origin: 'cloud' }])
    expect(listChangesAfter(db, 'aircraft', 0, 1)).toHaveLength(1)
    expect(listChangesAfter(db, 'flight', 0, 10)).toEqual([])
  })

  it('gives a row’s own updated_at from any of the four tables, and nothing for a row that is not there', () => {
    const plane = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const trip = createFlight(db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
    createLanding(db, {
      flightId: trip.id,
      seq: 1,
      icao: null,
      touchdownTsUtc: '2026-04-12T23:30:00.000Z',
      verticalSpeedMs: -1,
      gForce: 1,
      pitchDeg: 1,
      bankDeg: 0,
      headingTrueDeg: 270,
      indicatedAirspeedMs: 70,
      groundSpeedMs: 68,
      windSpeedMs: 5,
      windDirectionDeg: 260,
      headwindMs: null,
      crosswindMs: null,
      crabDeg: null,
      runwayIdent: null,
      distanceFromThresholdM: null,
      centrelineOffsetM: null,
      flapSetting: null,
      touchdownSource: 'derived',
      runwaySource: null
    })
    addInvoicesForFlight(db, trip.id, [
      {
        serviceGroup: 'fuel',
        receiptId: 'r1',
        issuedUtc: '2026-04-12T22:00:00Z',
        icao: 'EGLL',
        tail: 'G-ABCD',
        operator: null,
        totalUsd: 1,
        totalText: '£1',
        sourceHtmlPath: '/tmp/r1.html',
        receiptJson: '{}'
      }
    ])
    const rows = {
      aircraft: db.select().from(aircraft).get(),
      flight: db.select().from(flight).get(),
      landing: db.select().from(landing).get(),
      flightInvoice: db.select().from(flightInvoice).get()
    }
    for (const [table, row] of Object.entries(rows)) {
      expect(localUpdatedAt(db, table, row?.uuid as string)).toBe(row?.updatedAt)
      expect(localUpdatedAt(db, table, 'no-such-uuid')).toBeUndefined()
    }
  })
})
