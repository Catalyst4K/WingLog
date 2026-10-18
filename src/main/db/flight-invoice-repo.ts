/**
 * GSX ground-service invoices attached to flights. Additive only: a receipt is stored once per
 * flight and never edited, and deleting the flight soft-deletes them.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { FlightInvoice } from '@shared/ipc'
import type { StoredInvoiceInput } from '../gsx/scan'
import { flightInvoice } from './schema'
import type { WingLogDb } from './client'
import { rowsChangedSince, shouldApplyPulledRow } from './sync-rows'

/**
 * A database row as a FlightInvoice.
 *
 * @param row The `flight_invoice` row.
 * @returns The invoice as the app sees it.
 */
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

/**
 * A flight's invoices that aren't deleted.
 *
 * @param db The database.
 * @param flightId The flight.
 * @returns Its invoices.
 */
export function listInvoicesForFlight(db: WingLogDb, flightId: number): FlightInvoice[] {
  return db
    .select()
    .from(flightInvoice)
    .where(and(eq(flightInvoice.flightId, flightId), isNull(flightInvoice.deletedAt)))
    .all()
    .map(toFlightInvoice)
}

/**
 * Whether WingLog stored a receipt at this HTML path: the only receipts it will open for the
 * renderer.
 *
 * @param db The database.
 * @param htmlPath The receipt's HTML file, as the renderer passed it.
 * @returns True when a receipt that isn't deleted has exactly this path.
 */
export function isStoredReceiptPath(db: WingLogDb, htmlPath: string): boolean {
  const row = db
    .select({ id: flightInvoice.id })
    .from(flightInvoice)
    .where(and(eq(flightInvoice.sourceHtmlPath, htmlPath), isNull(flightInvoice.deletedAt)))
    .get()
  return row !== undefined
}

/**
 * Adds any of `invoices` not already stored for this flight (deduped on receiptId) and
 * returns the full, current list. Used by both the completion-time snapshot/manual
 * rescan (a batch of confidently-matched receipts) and manually attaching one NOTAIL
 * candidate — additive rather than replace-wholesale, so a repeated rescan can't
 * duplicate rows, and can't wipe out a receipt attached by hand that the confident-match
 * scan itself would never find again.
 *
 * @param db The database.
 * @param flightId The flight.
 * @param invoices The receipts to attach.
 * @returns The flight's invoices afterwards.
 */
export function addInvoicesForFlight(
  db: WingLogDb,
  flightId: number,
  invoices: StoredInvoiceInput[]
): FlightInvoice[] {
  const alreadyStored = new Set(listInvoicesForFlight(db, flightId).map((i) => i.receiptId))
  const toInsert = invoices.filter((i) => !alreadyStored.has(i.receiptId))
  if (toInsert.length > 0) {
    // uuid/updatedAt (winglog-backend/docs/plans/cloud-sync.md) — this table is
    // additive-only (no update path exists), so every row's uuid/updatedAt is set once,
    // here, at insert.
    const now = new Date().toISOString()
    db.insert(flightInvoice)
      .values(toInsert.map((invoice) => ({ flightId, ...invoice, uuid: randomUUID(), updatedAt: now })))
      .run()
  }
  return listInvoicesForFlight(db, flightId)
}

/**
 * See aircraft-repo.ts's listAircraftForSync for the shape/reasoning this mirrors.
 *
 * @param db The database.
 * @param since The sync cursor, or null for every row.
 * @returns The rows, oldest change first.
 */
export function listFlightInvoicesForSync(
  db: WingLogDb,
  since: string | null
): (typeof flightInvoice.$inferSelect)[] {
  return rowsChangedSince(db.select().from(flightInvoice).all(), since)
}

/** See aircraft-repo.ts's upsertAircraftByUuid for the shape/reasoning this mirrors. This
 *  table has no local update path outside sync (addInvoicesForFlight only ever inserts),
 *  so a pulled row that already exists locally by uuid is still handled — a second
 *  device's push landing back here after a conflict resolution, for instance.
 *
 * @param db The database.
 * @param input The pulled row.
 * @returns False when the local row is as new or newer, so nothing changed.
 */
export function upsertFlightInvoiceByUuid(
  db: WingLogDb,
  input: Omit<typeof flightInvoice.$inferInsert, 'id'> & { uuid: string }
): boolean {
  const existing = db.select().from(flightInvoice).where(eq(flightInvoice.uuid, input.uuid)).get()
  if (!shouldApplyPulledRow(existing, input.updatedAt)) return false
  if (existing) db.update(flightInvoice).set(input).where(eq(flightInvoice.uuid, input.uuid)).run()
  else db.insert(flightInvoice).values(input).run()
  return true
}
