/** The phones, tablets and other WingLogs paired with the second-screen server. Only token hashes are stored. */

import { and, eq, isNull } from 'drizzle-orm'
import type { WingLogDb } from './client'
import type { LanDeviceKind } from '@shared/ipc'
import { lanDevice } from './schema'

/** A paired device as Settings lists it: never the token or its hash. */
export interface LanDeviceSummary {
  id: number
  kind: LanDeviceKind
  name: string
  createdAt: string
  lastSeenAt: string | null
}

/**
 * @param db The database.
 * @param name The device's label.
 * @param tokenHash The SHA-256 hash of the token handed to it.
 * @param now The time, ISO text.
 * @param kind A second screen (the default) or a twin.
 * @returns The new device's id.
 */
export function addLanDevice(
  db: WingLogDb,
  name: string,
  tokenHash: string,
  now: string,
  kind: LanDeviceKind = 'screen'
): number {
  return db
    .insert(lanDevice)
    .values({ name, tokenHash, createdAt: now, kind })
    .returning({ id: lanDevice.id })
    .get().id
}

/**
 * @param db The database.
 * @param tokenHash The hash of a token a device presented.
 * @returns The device's id and kind, or null when the token is unknown or revoked.
 */
export function findActiveLanDevice(
  db: WingLogDb,
  tokenHash: string
): { id: number; kind: LanDeviceKind } | null {
  const row = db
    .select({ id: lanDevice.id, kind: lanDevice.kind })
    .from(lanDevice)
    .where(and(eq(lanDevice.tokenHash, tokenHash), isNull(lanDevice.revokedAt)))
    .get()
  return row ?? null
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
      kind: lanDevice.kind,
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
 * Renames a paired device (Settings → Devices). The name is checked by the caller.
 *
 * @param db The database.
 * @param id The device.
 * @param name Its new name.
 * @returns True when a paired (not revoked) device was renamed.
 */
export function renameLanDevice(db: WingLogDb, id: number, name: string): boolean {
  return (
    db
      .update(lanDevice)
      .set({ name })
      .where(and(eq(lanDevice.id, id), isNull(lanDevice.revokedAt)))
      .run().changes > 0
  )
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

/**
 * Revokes every paired device of one kind at once: their tokens stop working. Rows already revoked are left as they were.
 *
 * @param db The database.
 * @param kind The kind of device.
 * @param now The time, ISO text.
 * @returns How many devices were revoked.
 */
export function revokeLanDevicesOfKind(db: WingLogDb, kind: LanDeviceKind, now: string): number {
  return db
    .update(lanDevice)
    .set({ revokedAt: now })
    .where(and(eq(lanDevice.kind, kind), isNull(lanDevice.revokedAt)))
    .run().changes
}
