/**
 * One-off live-sim check for the REAL navdata provider code — src/main/navdata/ — against
 * a real running MSFS 2024. Unlike scripts/spike-facilities.ts (Phase 2, its own
 * standalone parsing code, already sim-confirmed and folded into the real
 * facility-fields.ts), this calls fetchAirportNavdata/replaceAirportNavdata/the repo's own
 * read functions directly — the exact same functions SimFacilitiesProvider and the
 * navdata* IPC handlers use — end to end, including the real SQLite cache and the isolated
 * connection-per-fetch, before any Dispatch UI gets built on top of them, per the M1/M6
 * spike-first rule (docs/plans/navdata-without-navigraph.md, Phase 3).
 *
 * Prints each procedure's header counts (N_RUNWAY_TRANSITIONS/N_ENROUTE_TRANSITIONS/
 * N_APPROACH_LEGS) alongside what actually got attached, so a real "the sim reports zero of
 * these" finding can be told apart from a parsing/attachment bug — this is exactly how the
 * confirmed-live finding that a SID's legs live inside its runway transition, not the
 * procedure's own common list, was originally found (docs/navdata-notes.md).
 *
 * Runs through electron in ELECTRON_RUN_AS_NODE=1 mode (see CLAUDE.md's Testing section) —
 * this script touches better-sqlite3, same as npm run db:migrate.
 *
 * Usage: npm run spike:navdata-provider -- VHHH
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open, Protocol } from 'node-simconnect'
import { createDb } from '../src/main/db/client'
import { migrateDb } from '../src/main/db/migrate'
import { listCachedProcedureLegs, listCachedProcedures, listCachedRunways, replaceAirportNavdata } from '../src/main/db/navdata-repo'
import { fetchAirportNavdata } from '../src/main/navdata/sim-facilities-fetch'

const icao = (process.argv[2] ?? process.env['SPIKE_ICAO'] ?? '').toUpperCase()
if (!/^[A-Z0-9]{4}$/.test(icao)) {
  console.error('Usage: npm run spike:navdata-provider -- <ICAO>')
  process.exit(1)
}

const dbDir = mkdtempSync(join(tmpdir(), 'winglog-navdata-provider-spike-'))
const dbPath = join(dbDir, 'spike.db')
console.log(`Scratch DB: ${dbPath}`)

migrateDb(dbPath, 'drizzle')
const { db, sqlite } = createDb(dbPath)

function legSummary(fixIdents: (string | null)[]): string {
  return fixIdents.length === 0 ? '(none)' : fixIdents.map((f) => f ?? '(no fix)').join(' -> ')
}

async function main(): Promise<void> {
  const { handle } = await open('WingLog navdata spike', Protocol.SunRise)

  console.log(`\nfetchAirportNavdata(${icao}) — real facility requests on their own connection...`)
  const start = Date.now()
  const fetchedResult = await fetchAirportNavdata(handle, icao)
  console.log(`Completed in ${Date.now() - start}ms`)
  handle.close()

  console.log(`\n${fetchedResult.runways.length} runway records (each becomes two ends once cached):`)
  for (const r of fetchedResult.runways) {
    console.log(
      `  ${r.primaryIdent}/${r.secondaryIdent}  hdg ${r.headingDeg.toFixed(1)}  ` +
        `${r.lengthM.toFixed(0)}m x ${r.widthM.toFixed(0)}m  surface=${r.surface}  ` +
        `centre=(${r.latitude.toFixed(6)}, ${r.longitude.toFixed(6)})`
    )
  }

  for (const [kind, procedures] of [
    ['departures (SIDs)', fetchedResult.departures],
    ['arrivals (STARs)', fetchedResult.arrivals]
  ] as const) {
    console.log(`\n${procedures.length} ${kind}:`)
    for (const p of procedures.slice(0, 5)) {
      console.log(`  ${p.name}  header: rwyTrans=${p.expected.runwayTransitions} enrTrans=${p.expected.enrouteTransitions} legs=${p.expected.approachLegs}`)
      console.log(`    common legs: ${legSummary(p.commonLegs.map((l) => l.fixIdent))}`)
      for (const rt of p.runwayTransitions) console.log(`    runway ${rt.runwayIdent}: ${legSummary(rt.legs.map((l) => l.fixIdent))}`)
      for (const et of p.enrouteTransitions) console.log(`    enroute ${et.name}: ${legSummary(et.legs.map((l) => l.fixIdent))}`)
    }
    if (procedures.length > 5) console.log(`  ...and ${procedures.length - 5} more`)
  }

  replaceAirportNavdata(db, icao, fetchedResult, new Date().toISOString())

  const cachedRunways = listCachedRunways(db, icao)
  console.log(`\nCached ${cachedRunways.length} runway ends after replaceAirportNavdata.`)

  const sids = listCachedProcedures(db, icao, 'sid', null)
  console.log(`Cached ${sids.length} SID options (identifier / transition):`)
  for (const s of sids.slice(0, 10)) console.log(`  ${s.identifier} / ${s.transition ?? '(none)'}`)

  if (sids.length > 0) {
    const first = fetchedResult.departures.find((p) => p.name === sids[0]!.identifier)
    const testRunway = first?.runwayTransitions[0]?.runwayIdent ?? null
    const commonOnly = listCachedProcedureLegs(db, icao, 'sid', sids[0]!.identifier)
    const withRunway = testRunway ? listCachedProcedureLegs(db, icao, 'sid', sids[0]!.identifier, testRunway) : []
    console.log(`\n${sids[0]!.identifier}'s cached legs — common only: ${legSummary(commonOnly.map((l) => l.fixIdent))}`)
    if (testRunway) console.log(`${sids[0]!.identifier}'s cached legs — with runway ${testRunway}: ${legSummary(withRunway.map((l) => l.fixIdent))}`)
  }

  if (cachedRunways.length > 0) {
    const testRunway = cachedRunways[0]!.ident
    const filtered = listCachedProcedures(db, icao, 'sid', testRunway)
    console.log(`\n${filtered.length} of ${sids.length} SIDs apply to runway ${testRunway} (runway-filter check)`)
  }

  sqlite.close()
}

main().catch((error: unknown) => {
  console.error('Failed:', error)
  sqlite.close()
  process.exit(1)
})
