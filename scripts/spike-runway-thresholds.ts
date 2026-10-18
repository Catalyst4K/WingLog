/**
 * Live probe: how MSFS's RUNWAY facility record carries a displaced threshold. Registers PRIMARY_THRESHOLD and SECONDARY_THRESHOLD
 * (LENGTH, the displaced part in metres) inside OPEN RUNWAY, and prints each runway's two ends with the sim's figures beside
 * OurAirports' displaced_threshold_ft, so which end each record belongs to is read off real asymmetric cases. The nested records arrive as
 * separate PAVEMENT messages straight after their RUNWAY message (winglog-backend docs/navdata-notes.md, 2026-10-17). Needs MSFS running
 * with an aircraft loaded. Read-only; touches no database.
 *
 * Usage: npm run spike:runway-thresholds [-- ICAO ...]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Protocol, type RecvFacilityData, type SimConnectConnection } from 'node-simconnect'
import { openSimConnect } from '../src/main/sim/open-simconnect'
import { addRunwayFields, type ParsedRunway } from '../src/main/sim/facility-fields'
import { createRunwayCollector } from '../src/main/sim/runway-collector'

const DEFAULT_AIRPORTS = ['ENBR', 'EGLL', 'EGCC', 'WSSS', 'KJFK', 'LSZH', 'ENGM', 'EDDF']
const WAIT_MS = 15_000
const DEF_ID = 9100

/** OurAirports' displaced_threshold_ft per airport and end, in metres. */
function databaseDisplaced(icao: string): Map<string, number> {
  const rows = readFileSync(join('resources', 'runways.csv'), 'utf8').split('\n')
  const header = (rows[0] ?? '').trim().split(',')
  const col = (name: string): number => header.indexOf(name)
  const found = new Map<string, number>()
  for (const line of rows.slice(1)) {
    const cells = line.trim().split(',')
    if (cells[col('icao')] === icao) {
      found.set(
        cells[col('ident')] ?? '',
        Math.round(Number(cells[col('displaced_threshold_ft')] ?? 0) * 0.3048)
      )
    }
  }
  return found
}

function fetchStrips(handle: SimConnectConnection, icao: string): Promise<ParsedRunway[]> {
  return new Promise((resolve) => {
    const collector = createRunwayCollector()
    const done = (): void => {
      clearTimeout(timer)
      handle.removeListener('facilityData', onData)
      handle.removeListener('facilityDataEnd', onEnd)
      resolve(collector.runways)
    }
    const onData = (recv: RecvFacilityData): void => {
      if (recv.userRequestId === DEF_ID) collector.take(recv)
    }
    const onEnd = (recv: { userRequestId: number }): void => {
      if (recv.userRequestId === DEF_ID) done()
    }
    const timer = setTimeout(done, WAIT_MS)
    handle.on('facilityData', onData)
    handle.on('facilityDataEnd', onEnd)
    handle.addToFacilityDefinition(DEF_ID, 'OPEN AIRPORT')
    handle.addToFacilityDefinition(DEF_ID, 'ICAO')
    addRunwayFields((name) => handle.addToFacilityDefinition(DEF_ID, name))
    handle.addToFacilityDefinition(DEF_ID, 'CLOSE AIRPORT')
    handle.requestFacilityData(DEF_ID, DEF_ID, icao)
  })
}

async function main(): Promise<void> {
  const airports = process.argv.slice(2).map((a) => a.toUpperCase())
  const { handle } = await openSimConnect('WingLog runway threshold probe', Protocol.SunRise)
  try {
    for (const icao of airports.length > 0 ? airports : DEFAULT_AIRPORTS) {
      const db = databaseDisplaced(icao)
      const strips = await fetchStrips(handle, icao)
      for (const s of strips) {
        const fmt = (v: number | null | undefined): string => (v == null ? '-' : v.toFixed(0))
        console.log(
          `${icao} ${s.primaryIdent.padEnd(3)}/${s.secondaryIdent.padEnd(3)} hdg ${s.headingDeg.toFixed(0)} len ${s.lengthM.toFixed(0)}  sim ${s.primaryIdent} ${fmt(s.primaryDisplacedM)} ${s.secondaryIdent} ${fmt(s.secondaryDisplacedM)}   OurAirports ${s.primaryIdent} ${db.get(s.primaryIdent) ?? '-'} ${s.secondaryIdent} ${db.get(s.secondaryIdent) ?? '-'}`
        )
      }
    }
  } finally {
    handle.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
