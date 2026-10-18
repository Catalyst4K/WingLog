/** The phones and tablets paired with the second-screen server. Only token hashes are stored. */

import { and, eq, isNull } from 'drizzle-orm'
import type { WingLogDb } from './client'
import { lanDevice } from './schema'

/** A paired device as Settings lists it: never the token or its hash. */
export interface LanDeviceSummary {
  id: number
  name: string
  createdAt: string
  lastSeenAt: string | null
}

/**
 * @param db The database.
 * @param name The device's label.
 * @param tokenHash The SHA-256 hash of the token handed to it.
 * @param now The time, ISO text.
 * @returns The new device's id.
 */
export function addLanDevice(db: WingLogDb, name: string, tokenHash: string, now: string): number {
  return db
    .insert(lanDevice)
    .values({ name, tokenHash, createdAt: now })
    .returning({ id: lanDevice.id })
    .get().id
}

/**
 * @param db The database.
 * @param tokenHash The hash of a token a device presented.
 * @returns The device's id, or null when the token is unknown or revoked.
 */
export function findActiveLanDevice(db: WingLogDb, tokenHash: string): number | null {
  const row = db
    .select({ id: lanDevice.id })
    .from(lanDevice)
    .where(and(eq(lanDevice.tokenHash, tokenHash), isNull(lanDevice.revokedAt)))
    .get()
  return row?.id ?? null
}

/**
 * @param db The database.
 * @param id The device.
 * @param now The time, ISO text.
 */
export function touchLanDevice(db: WingLogDb, id: number, now: string): void {
  db.update(lanDevice).set({ lastSeenAt: now }).where(eq(lanDevice.id, id)).run()
}

/**
 * @param db The database.
 * @returns The devices that are still paired, oldest first.
 */
export function listLanDevices(db: WingLogDb): LanDeviceSummary[] {
  return db
    .select({
      id: lanDevice.id,
      name: lanDevice.name,
      createdAt: lanDevice.createdAt,
      lastSeenAt: lanDevice.lastSeenAt
    })
    .from(lanDevice)
    .where(isNull(lanDevice.revokedAt))
    .orderBy(lanDevice.id)
    .all()
}

/**
 * Revokes a device: its token stops working at once. The row is kept.
 *
 * @param db The database.
 * @param id The device.
 * @param now The time, ISO text.
 * @returns True when a paired device was revoked.
 */
export function revokeLanDevice(db: WingLogDb, id: number, now: string): boolean {
  return (
    db
      .update(lanDevice)
      .set({ revokedAt: now })
      .where(and(eq(lanDevice.id, id), isNull(lanDevice.revokedAt)))
      .run().changes > 0
  )
}
