// One-off backfill for the aircraft.operator_icao column added alongside SimBrief
// generation support (docs/decisions.md) — the existing fleet has operator_iata (used for
// the airline logo) but never had an ICAO code stored, which is what SimBrief's `airline`
// generation parameter and a real-world callsign actually want.
//
// Matches each aircraft's stored operator_iata against the vendored airline list
// (src/main/airlines/airline-search.ts) and fills operator_icao where found. Reports
// anything unmatched rather than guessing — a fleet aircraft with a free-typed operator
// name (no IATA code at all) has nothing to recover from, and that's fine: the
// flight-number field just stays fully manual for that aircraft until edited by hand.
//
// Run via `npm run db:backfill-operator-icao` — same ELECTRON_RUN_AS_NODE mechanism as
// db-migrate.ts, so better-sqlite3's native module matches the Electron ABI it was built
// against (see CLAUDE.md's Testing section).
//
// Reads the vendored airline CSVs via fs and parses them with parseCsvRows/columnIndex
// directly, rather than importing airline-search.ts — that module's top-level `?raw`
// imports are a Vite-only loader syntax, and the whole module body (including those
// imports) executes on import regardless of which export is used, so even importing just
// loadAirlines from it still fails under tsx (used to run this script outside Vite).
import fs from 'node:fs'
import path from 'node:path'
import { createDb } from '../src/main/db/client'
import { listAircraft, updateAircraft } from '../src/main/db/aircraft-repo'
import { columnIndex, parseCsvRows } from '../src/main/db/csv'

function loadAirlines(raw: string): { name: string; icao: string; iata: string }[] {
  const [header, ...rows] = parseCsvRows(raw)
  const nameIdx = columnIndex(header, 'name')
  const icaoIdx = columnIndex(header, 'icao')
  const iataIdx = columnIndex(header, 'iata')
  return rows
    .filter((row) => row[nameIdx] && row[icaoIdx])
    .map((row) => ({ name: row[nameIdx], icao: row[icaoIdx], iata: row[iataIdx] || '' }))
}

const resourcesDir = path.join(__dirname, '../resources')
const airlines = [
  ...loadAirlines(fs.readFileSync(path.join(resourcesDir, 'airlines.csv'), 'utf-8')),
  ...loadAirlines(fs.readFileSync(path.join(resourcesDir, 'airline-aliases.csv'), 'utf-8'))
]

function findAirlineByIata(iata: string) {
  const q = iata.trim().toLowerCase()
  if (!q) return undefined
  return airlines.find((a) => a.iata.toLowerCase() === q)
}

const dbPath = process.env.WINGLOG_DB_PATH ?? './winglog.db'
const { db } = createDb(dbPath)

let updated = 0
const unmatched: string[] = []

for (const aircraft of listAircraft(db)) {
  if (aircraft.operatorIcao) continue
  if (!aircraft.operatorIata) continue

  const match = findAirlineByIata(aircraft.operatorIata)
  if (!match) {
    unmatched.push(`${aircraft.registration} (operator IATA "${aircraft.operatorIata}")`)
    continue
  }

  updateAircraft(db, { ...aircraft, operatorIcao: match.icao })
  updated++
}

console.log(`Backfilled operator_icao for ${updated} aircraft.`)
if (unmatched.length > 0) {
  console.log(`No match for ${unmatched.length} aircraft — left as-is:`)
  for (const line of unmatched) console.log(`  ${line}`)
}
