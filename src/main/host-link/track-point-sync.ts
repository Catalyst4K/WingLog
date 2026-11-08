/**
 * The recorded track of completed flights, brought from the sim PC (winglog-backend's docs/plans/multi-device.md, Part 4; Callum chose LAN
 * sync, not cloud, to carry them). The flights themselves arrive with the sync of the flight table; their points are too many for it, so a
 * client asks for the track of each completed flight it has none of, in pages, once.
 */

import type { WingLogDb } from '../db/client'
import { listCompletedFlightsWithoutTrack, insertTrackPointRows } from '../db/track-point-repo'
import { trackPoint } from '../db/schema'
import { logger } from '../logging/logger'
import { validateSyncFields } from '../sync/sync-row-validation'

/** Asks the sim PC a lookup (`HostLink.query`). */
type Ask = (name: string, ...args: unknown[]) => Promise<unknown>

/** A host that never says it has no more pages is not asked for ever: a flight has far fewer than this many. */
const MAX_PAGES = 1000

/**
 * @param value The sim PC's answer to a track page.
 * @returns Its points, and where the next page starts (null at the end).
 * @throws When the answer is not a page.
 */
function pageFrom(value: unknown): { points: Record<string, unknown>[]; next: number | null } {
  const page = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  if (!page || !Array.isArray(page.points)) throw new Error('The sim PC sent a track that is not points')
  const next = typeof page.next === 'number' && Number.isSafeInteger(page.next) ? page.next : null
  return { points: page.points as Record<string, unknown>[], next }
}

/**
 * Fetches the track of every completed flight that has none here, and stores it.
 *
 * @param db The database.
 * @param ask Asks the sim PC a lookup.
 * @returns How many flights' tracks were brought.
 */
export async function syncTrackPoints(db: WingLogDb, ask: Ask): Promise<number> {
  let brought = 0
  for (const flight of listCompletedFlightsWithoutTrack(db)) {
    const rows: (typeof trackPoint.$inferInsert)[] = []
    let offset: number | null = 0
    for (let page = 0; offset !== null && page < MAX_PAGES; page++) {
      const answer = pageFrom(await ask('sync.trackPoints', flight.uuid, offset))
      for (const point of answer.points) {
        const checked = validateSyncFields(trackPoint, point, ['flightId'])
        if (checked.ok)
          rows.push({ ...checked.fields, flightId: flight.id } as typeof trackPoint.$inferInsert)
        else logger.warn(`[twin-sync] a track point of flight ${flight.uuid} was refused: ${checked.error}`)
      }
      offset = answer.next
    }
    if (rows.length > 0) {
      insertTrackPointRows(db, rows)
      brought += 1
    }
  }
  return brought
}
