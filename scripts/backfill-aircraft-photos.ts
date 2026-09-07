// One-off backfill for aircraft.photo_thumbnail_url (docs/plans/fleet-redesign.md #3).
//
// The photo is only ever filled by clicking "Look up" in the Add/Edit aircraft form
// (AircraftForm.tsx) — nothing populates it automatically, so the 17 real aircraft
// imported before this feature shipped, and any added since without running a lookup,
// have no photo on record even where adsbdb has one. This re-runs the same
// fetchAircraftByRegistration lookup the form uses, for every aircraft currently missing
// a photo, and fills it in where adsbdb returns one — same "fill blanks only" restraint
// as the form itself (never overwrites a photo already on record).
//
// adsbdb has no documented rate limit (adsbdb-client.ts), but this is someone else's free
// API, not ours — a small delay between requests is just being a polite caller, not a
// workaround for a real limit we've hit.
//
// Run via `npm run db:backfill-aircraft-photos` — same ELECTRON_RUN_AS_NODE mechanism as
// db-migrate.ts, so better-sqlite3's native module matches the Electron ABI it was built
// against (see CLAUDE.md's Testing section). Close the app first — this writes to the
// same on-disk database file the running app has open.
import { createDb } from '../src/main/db/client'
import { listAircraft, updateAircraft } from '../src/main/db/aircraft-repo'
import { fetchAircraftByRegistration } from '../src/main/aircraft-lookup/adsbdb-client'

const DELAY_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const dbPath = process.env.FLIGHTDECK_DB_PATH ?? './flightdeck.db'
  const { db } = createDb(dbPath)

  const candidates = listAircraft(db).filter((a) => !a.photoThumbnailUrl)
  console.log(`${candidates.length} aircraft missing a photo — checking adsbdb...`)

  let updated = 0
  const noPhoto: string[] = []
  const failed: string[] = []

  for (const aircraft of candidates) {
    try {
      const result = await fetchAircraftByRegistration(aircraft.registration)
      if (result?.photoThumbnailUrl) {
        updateAircraft(db, { ...aircraft, photoThumbnailUrl: result.photoThumbnailUrl })
        updated++
        console.log(`  ${aircraft.registration}: found`)
      } else {
        noPhoto.push(aircraft.registration)
      }
    } catch (err) {
      failed.push(`${aircraft.registration} (${err instanceof Error ? err.message : String(err)})`)
    }
    await sleep(DELAY_MS)
  }

  console.log(`\nFilled photo_thumbnail_url for ${updated} aircraft.`)
  if (noPhoto.length > 0) {
    console.log(`No photo available for ${noPhoto.length}: ${noPhoto.join(', ')}`)
  }
  if (failed.length > 0) {
    console.log(`Lookup failed for ${failed.length}:`)
    for (const line of failed) console.log(`  ${line}`)
  }
}

main()
