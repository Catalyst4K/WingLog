/** Records on a flight that it was flown on an online network (winglog-backend docs/plans/vatsim-build.md, Step 2). */
import { eq } from 'drizzle-orm'
import type { OnlineNetwork } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { flight } from '../db/schema'

/**
 * Records that a flight was flown on an online network.
 *
 * @param db The database.
 * @param id The flight.
 * @param network The network.
 * @param callsign The callsign used there.
 */
export function setFlightOnline(db: WingLogDb, id: number, network: OnlineNetwork, callsign: string): void {
  db.update(flight)
    .set({ onlineNetwork: network, onlineCallsign: callsign, updatedAt: new Date().toISOString() })
    .where(eq(flight.id, id))
    .run()
}
