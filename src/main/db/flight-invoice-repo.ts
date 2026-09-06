import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FlightInvoice } from '@shared/ipc'
import type { StoredInvoiceInput } from '../gsx/scan'
import { flightInvoice } from './schema'
import type { FlightdeckDb } from './client'

function toFlightInvoice(row: typeof flightInvoice.$inferSelect): FlightInvoice {
  return {
    id: row.id,
    flightId: row.flightId,
    serviceGroup: row.serviceGroup,
    receiptId: row.receiptId,
    issuedUtc: row.issuedUtc,
    icao: row.icao,
    tail: row.tail,
    operator: row.operator,
    totalUsd: row.totalUsd,
    totalText: row.totalText,
    sourceHtmlPath: row.sourceHtmlPath,
    receiptJson: row.receiptJson
  }
}

export function listInvoicesForFlight(db: FlightdeckDb, flightId: number): FlightInvoice[] {
  return db.select().from(flightInvoice).where(eq(flightInvoice.flightId, flightId)).all().map(toFlightInvoice)
}

/**
 * Adds any of `invoices` not already stored for this flight (deduped on receiptId) and
 * returns the full, current list. Used by both the completion-time snapshot/manual
 * rescan (a batch of confidently-matched receipts) and manually attaching one NOTAIL
 * candidate — additive rather than replace-wholesale, so a repeated rescan can't
 * duplicate rows, and can't wipe out a receipt attached by hand that the confident-match
 * scan itself would never find again.
 */
export function addInvoicesForFlight(
  db: FlightdeckDb,
  flightId: number,
  invoices: StoredInvoiceInput[]
): FlightInvoice[] {
  const alreadyStored = new Set(listInvoicesForFlight(db, flightId).map((i) => i.receiptId))
  const toInsert = invoices.filter((i) => !alreadyStored.has(i.receiptId))
  if (toInsert.length > 0) {
    // uuid/updatedAt (flightdeck-backend/docs/plans/cloud-sync.md) — this table is
    // additive-only (no update path exists), so every row's uuid/updatedAt is set once,
    // here, at insert.
    const now = new Date().toISOString()
    db.insert(flightInvoice)
      .values(toInsert.map((invoice) => ({ flightId, ...invoice, uuid: randomUUID(), updatedAt: now })))
      .run()
  }
  return listInvoicesForFlight(db, flightId)
}

/** See aircraft-repo.ts's listAircraftForSync for the shape/reasoning this mirrors. */
export function listFlightInvoicesForSync(db: FlightdeckDb, since: string | null): (typeof flightInvoice.$inferSelect)[] {
  const rows = db.select().from(flightInvoice).all()
  return rows
    .filter((row) => row.uuid !== null && row.updatedAt !== null && (since === null || row.updatedAt > since))
    .sort((a, b) => (a.updatedAt as string).localeCompare(b.updatedAt as string))
}

/** See aircraft-repo.ts's upsertAircraftByUuid for the shape/reasoning this mirrors. This
 *  table has no local update path outside sync (addInvoicesForFlight only ever inserts),
 *  so a pulled row that already exists locally by uuid is still handled — a second
 *  device's push landing back here after a conflict resolution, for instance. */
export function upsertFlightInvoiceByUuid(
  db: FlightdeckDb,
  input: Omit<typeof flightInvoice.$inferInsert, 'id'> & { uuid: string }
): void {
  const existing = db.select().from(flightInvoice).where(eq(flightInvoice.uuid, input.uuid)).get()
  if (existing) {
    db.update(flightInvoice).set(input).where(eq(flightInvoice.uuid, input.uuid)).run()
  } else {
    db.insert(flightInvoice).values(input).run()
  }
}
