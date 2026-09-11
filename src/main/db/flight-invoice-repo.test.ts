import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { createDb, type WingLogDb } from './client'
import { createAircraft } from './aircraft-repo'
import { createFlight } from './flight-repo'
import { flightInvoice } from './schema'
import type { StoredInvoiceInput } from '../gsx/scan'
import {
  addInvoicesForFlight,
  listFlightInvoicesForSync,
  listInvoicesForFlight,
  upsertFlightInvoiceByUuid
} from './flight-invoice-repo'

function makeInvoice(overrides: Partial<StoredInvoiceInput> = {}): StoredInvoiceInput {
  return {
    serviceGroup: 'fuel',
    receiptId: 'RCPT-1',
    issuedUtc: '2026-09-06T12:00:00.000Z',
    icao: 'EGLL',
    tail: 'G-ABCD',
    operator: 'Test Fuel Co',
    totalUsd: 123.45,
    totalText: '$123.45',
    sourceHtmlPath: 'C:\\GSX\\Fuel\\receipt.html',
    receiptJson: '{"total":"$123.45"}',
    ...overrides
  }
}

describe('flight invoice repo', () => {
  let db: WingLogDb
  let flightId: number

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    const aircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    flightId = createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' }).id
  })

  it('starts with no invoices for a flight', () => {
    expect(listInvoicesForFlight(db, flightId)).toEqual([])
  })

  it('adds invoices for a flight and returns the full current list', () => {
    const result = addInvoicesForFlight(db, flightId, [makeInvoice()])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ flightId, receiptId: 'RCPT-1', totalUsd: 123.45 })
    expect(listInvoicesForFlight(db, flightId)).toEqual(result)
  })

  it('dedupes by receiptId rather than inserting a duplicate row', () => {
    addInvoicesForFlight(db, flightId, [makeInvoice()])
    const second = addInvoicesForFlight(db, flightId, [makeInvoice({ totalUsd: 999 })])
    expect(second).toHaveLength(1)
    expect(second[0].totalUsd).toBe(123.45)
  })

  it('adds only the new receipts among a mixed batch', () => {
    addInvoicesForFlight(db, flightId, [makeInvoice({ receiptId: 'RCPT-1' })])
    const result = addInvoicesForFlight(db, flightId, [
      makeInvoice({ receiptId: 'RCPT-1' }),
      makeInvoice({ receiptId: 'RCPT-2', serviceGroup: 'catering' })
    ])
    expect(result.map((r) => r.receiptId).sort()).toEqual(['RCPT-1', 'RCPT-2'])
  })

  it('excludes soft-deleted invoices from listInvoicesForFlight', () => {
    addInvoicesForFlight(db, flightId, [makeInvoice()])
    const row = db.select().from(flightInvoice).where(eq(flightInvoice.flightId, flightId)).get()!
    db.update(flightInvoice).set({ deletedAt: new Date().toISOString() }).where(eq(flightInvoice.id, row.id)).run()
    expect(listInvoicesForFlight(db, flightId)).toEqual([])
  })

  describe('listFlightInvoicesForSync', () => {
    it('returns every synced-eligible row when since is null, oldest first', () => {
      addInvoicesForFlight(db, flightId, [makeInvoice({ receiptId: 'A' })])
      addInvoicesForFlight(db, flightId, [makeInvoice({ receiptId: 'B' })])
      const rows = listFlightInvoicesForSync(db, null)
      expect(rows.map((r) => r.receiptId)).toEqual(['A', 'B'])
    })

    it('excludes rows updated at or before since', () => {
      addInvoicesForFlight(db, flightId, [makeInvoice({ receiptId: 'A' })])
      const cutoff = db.select().from(flightInvoice).get()!.updatedAt as string
      addInvoicesForFlight(db, flightId, [makeInvoice({ receiptId: 'B' })])
      const rows = listFlightInvoicesForSync(db, cutoff)
      expect(rows.map((r) => r.receiptId)).toEqual(['B'])
    })
  })

  describe('upsertFlightInvoiceByUuid', () => {
    it('inserts a new row when no uuid match exists', () => {
      const applied = upsertFlightInvoiceByUuid(db, {
        uuid: 'remote-uuid-1',
        flightId,
        serviceGroup: 'fuel',
        receiptId: 'REMOTE-1',
        issuedUtc: '2026-09-06T12:00:00.000Z',
        icao: 'EGLL',
        tail: 'G-ABCD',
        operator: null,
        totalUsd: null,
        totalText: null,
        sourceHtmlPath: 'C:\\GSX\\Fuel\\r.html',
        receiptJson: '{}',
        updatedAt: '2026-09-06T12:00:00.000Z'
      })
      expect(applied).toBe(true)
      expect(listInvoicesForFlight(db, flightId).map((i) => i.receiptId)).toEqual(['REMOTE-1'])
    })

    it('updates an existing row by uuid when the incoming version is newer', () => {
      addInvoicesForFlight(db, flightId, [makeInvoice({ receiptId: 'RCPT-1' })])
      const existing = db.select().from(flightInvoice).where(eq(flightInvoice.flightId, flightId)).get()!

      const applied = upsertFlightInvoiceByUuid(db, {
        ...existing,
        totalUsd: 555,
        updatedAt: '2099-01-01T00:00:00.000Z'
      })

      expect(applied).toBe(true)
      expect(listInvoicesForFlight(db, flightId)[0].totalUsd).toBe(555)
    })

    it('refuses to apply an incoming row that is not newer than the local one', () => {
      addInvoicesForFlight(db, flightId, [makeInvoice({ receiptId: 'RCPT-1' })])
      const existing = db.select().from(flightInvoice).where(eq(flightInvoice.flightId, flightId)).get()!

      const applied = upsertFlightInvoiceByUuid(db, {
        ...existing,
        totalUsd: 1,
        updatedAt: '2000-01-01T00:00:00.000Z'
      })

      expect(applied).toBe(false)
      expect(listInvoicesForFlight(db, flightId)[0].totalUsd).toBe(123.45)
    })
  })
})
