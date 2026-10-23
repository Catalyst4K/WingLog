/**
 * Live check for winglog-backend's docs/plans/taxi-network-as-flown.md: runs the production `fetchTaxiNetwork` (one combined
 * request) against the running sim, checks every record was read to its last byte, and reports the path types and field ranges
 * against what the 2026-10-21 spike saw. With SPIKE_FIXTURE=<ICAO>, also writes that airport's raw records as the test fixture
 * src/main/navdata/__fixtures__/taxi-network-<icao>.json (airport data only; nothing personal).
 *
 * Usage (MSFS running):
 *   npx tsx scripts/spike-taxi-network-fetch.ts                         # EGKB, ZJSY, VHHH, EGLL
 *   SPIKE_ICAOS=EGKB SPIKE_FIXTURE=EGKB npx tsx scripts/spike-taxi-network-fetch.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FacilityDataType, open, Protocol, type RecvFacilityData } from 'node-simconnect'
import { fetchTaxiNetwork } from '../src/main/navdata/sim-facilities-fetch'

const ICAOS = (process.env['SPIKE_ICAOS'] ?? 'EGKB,ZJSY,VHHH,EGLL')
  .split(',')
  .map((s) => s.trim().toUpperCase())
const FIXTURE = process.env['SPIKE_FIXTURE']?.toUpperCase()
const SEEN_TYPES = new Set([1, 2, 3, 4, 5, 6, 7])

interface RawRecord {
  type: number
  itemIndex: number
  bytes: string
}

async function main(): Promise<void> {
  for (const icao of ICAOS) {
    // A fresh connection per airport, as the provider does.
    const { handle } = await open('WingLog taxi-network check', Protocol.SunRise)
    const records: RawRecord[] = []
    const leftOver: Record<number, number> = {}
    const pathTypes: Record<number, number> = {}
    const before = (recv: RecvFacilityData): void => {
      const d = recv.data
      const start = d.getOffset()
      const bytes = d.readBytes(d.remaining())
      d.setOffset(start)
      records.push({ type: recv.type, itemIndex: recv.itemIndex, bytes: bytes.toString('base64') })
      if (recv.type === FacilityDataType.TAXI_PATH) {
        const type = bytes.readInt32LE(0)
        pathTypes[type] = (pathTypes[type] ?? 0) + 1
      }
    }
    const after = (recv: RecvFacilityData): void => {
      if (recv.data.remaining() !== 0) leftOver[recv.type] = (leftOver[recv.type] ?? 0) + 1
    }
    handle.on('facilityData', before)
    const started = Date.now()
    const fetching = fetchTaxiNetwork(handle, icao)
    handle.on('facilityData', after)
    try {
      const network = await fetching
      const ms = Date.now() - started
      const kept: Record<number, number> = {}
      for (const s of network.segments) kept[s.pathType] = (kept[s.pathType] ?? 0) + 1
      const widths = network.segments.map((s) => s.widthM)
      const runways = network.segments.filter((s) => s.runwayNumber !== null)
      const odd = runways.filter(
        (s) =>
          (s.runwayNumber ?? 0) < 1 ||
          (s.runwayNumber ?? 0) > 36 ||
          (s.runwayDesignator ?? 0) < 0 ||
          (s.runwayDesignator ?? 0) > 3
      )
      const unknownTypes = Object.keys(pathTypes)
        .map(Number)
        .filter((t) => !SEEN_TYPES.has(t))
      const names = new Set(network.segments.map((s) => s.name).filter((n) => n !== null))
      console.log(
        `${icao}: ${ms} ms, ${records.length} records; path types received ${JSON.stringify(pathTypes)}, kept ${JSON.stringify(kept)}; ` +
          `${network.segments.length} segments, ${names.size} taxiway names, ${network.stands.length} stands; ` +
          `width ${Math.min(...widths)}-${Math.max(...widths)} m; runway paths ${runways.length} ` +
          `(${[...new Set(runways.map((s) => `${s.runwayNumber}/${s.runwayDesignator}`))].join(' ')}); ` +
          `records not read to the end ${JSON.stringify(leftOver)}; unknown path types ${JSON.stringify(unknownTypes)}; odd runway fields ${odd.length}`
      )
      if (icao === FIXTURE) {
        const dir = join(process.cwd(), 'src', 'main', 'navdata', '__fixtures__')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `taxi-network-${icao.toLowerCase()}.json`)
        writeFileSync(
          file,
          JSON.stringify({ icao, capturedAt: new Date().toISOString().slice(0, 10), records })
        )
        console.log(`  fixture written: ${file}`)
      }
    } finally {
      handle.close()
    }
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
