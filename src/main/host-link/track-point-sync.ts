/**
 * The recorded track of completed flights, brought from the sim PC (winglog-backend's docs/plans/multi-device.md, Part 4; Callum chose LAN
 * sync, not cloud, to carry them). The flights themselves arrive with the sync of the flight table; their points are too many for it, so a
 * client asks for the track of each completed flight it has none of, in pages, once.
 */

import type { WingLogDb } from '../db/client'
import {
  discardUnfinishedTracks,
  insertTrackPointRows,
  listCompletedFlightsWithoutTrack,
  markTrackFinished,
  markTrackUnfinished
} from '../db/track-point-repo'
import { trackPoint } from '../db/schema'
import { logger } from '../logging/logger'
import { validateSyncFields } from '../sync/sync-row-validation'
import { timeSlicer } from '../sync/time-slice'

/** Asks the sim PC a lookup (`HostLink.query`). */
type Ask = (name: string, ...args: unknown[]) => Promise<unknown>

/** Points stored in one transaction: a few tens of milliseconds, so the app is never held for long. */
export const INSERT_CHUNK = 1000

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
 * @param ask Asks the sim PC a lookup.
 * @returns The uuids of the flights the sim PC has a track for; null when it cannot say (an older sim PC, or an answer that is not a list), and
 *   then every flight is asked for, as before. Asking for a track the sim PC does not have costs a round trip each, so with 150 imported
 *   flights that never had one the pass took longer than the sync it followed.
 */
async function flightsWithTrack(ask: Ask): Promise<Set<string> | null> {
  try {
    const answer = await ask('sync.trackedFlights')
    if (!Array.isArray(answer) || answer.some((uuid) => typeof uuid !== 'string')) return null
    return new Set(answer as string[])
  } catch {
    return null
  }
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
  // A track left half stored by a stop between chunks is removed, and so fetched again whole.
  discardUnfinishedTracks(db)
  const tracked = await flightsWithTrack(ask)
  // A track is thousands of points checked one by one, and stored in chunks: the app gets the thread back between them. Because a flight with
  // any point counts as having its track, the flight is marked while it is stored in pieces.
  const slice = timeSlicer()
  for (const flight of listCompletedFlightsWithoutTrack(db)) {
    if (tracked && !tracked.has(flight.uuid)) continue
    const rows: (typeof trackPoint.$inferInsert)[] = []
    let offset: number | null = 0
    for (let page = 0; offset !== null && page < MAX_PAGES; page++) {
      const answer = pageFrom(await ask('sync.trackPoints', flight.uuid, offset))
      for (const point of answer.points) {
        await slice()
        const checked = validateSyncFields(trackPoint, point, ['flightId'])
        if (checked.ok)
          rows.push({ ...checked.fields, flightId: flight.id } as typeof trackPoint.$inferInsert)
        else logger.warn(`[twin-sync] a track point of flight ${flight.uuid} was refused: ${checked.error}`)
      }
      offset = answer.next
    }
    if (rows.length > 0) {
      markTrackUnfinished(db, flight.uuid)
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        insertTrackPointRows(db, rows.slice(i, i + INSERT_CHUNK))
        await slice()
      }
      markTrackFinished(db, flight.uuid)
      brought += 1
    }
  }
  return brought
}
