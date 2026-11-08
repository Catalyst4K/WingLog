/** Which lookup a device's query runs (LanServer.ts): the shared table, or for a twin the sync lookups that are told which device is asking. */

import { TWIN_ONLY_QUERIES } from '@shared/lan-queries'
import type { LanDeviceKind } from '@shared/types/lan'

/** The tables a lookup is found in. */
interface QueryTables {
  queries: Record<string, (...args: unknown[]) => unknown>
  deviceQueries?: Record<string, (deviceId: number, ...args: unknown[]) => unknown>
}

/**
 * @param tables The lookups the server has.
 * @param kind What kind of device is asking, null before it has paired: the twin-only lookups do not exist for a phone, a tablet or an unpaired device.
 * @param deviceId The asking device, once paired; a lookup that needs it is not run for a device without one.
 * @param name The lookup's name, as the device sent it.
 * @returns The lookup, ready to call with the device's arguments, or null when there is none for this device.
 */
export function findQuery(
  tables: QueryTables,
  kind: LanDeviceKind | null,
  deviceId: number | null,
  name: unknown
): ((...args: unknown[]) => unknown) | null {
  if (typeof name !== 'string') return null
  if (kind !== 'twin' && TWIN_ONLY_QUERIES.includes(name)) return null
  const withDevice =
    tables.deviceQueries && Object.hasOwn(tables.deviceQueries, name) ? tables.deviceQueries[name] : null
  if (withDevice) return deviceId === null ? null : (...args) => withDevice(deviceId, ...args)
  return Object.hasOwn(tables.queries, name) ? tables.queries[name] : null
}
