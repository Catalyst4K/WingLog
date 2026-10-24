/**
 * Throwaway spike for winglog-backend's docs/plans/taxi-routing-rules.md, step 1: fetch everything the sim says about an
 * airport's taxi network (every TAXI_PATH field the SDK documents, every path type, the points, names and parking spots) and
 * save it as JSON, so it can be compared with BeyondATC's own saved copy of the same network
 * (`%USERPROFILE%\AppData\LocalLow\Skirmish Mode Games, Inc\BeyondATC\GeneratedAirports\<ICAO>.json`) and used to work out
 * taxi routing rules. WingLog's own fetch today keeps only path types 1 and 4, their names and the hold-short points.
 *
 * Field list and types from the SDK reference (SimConnect_AddToFacilityDefinition, TAXI_PATH/TAXI_POINT/TAXI_NAME/
 * TAXI_PARKING). Each record's bytes are checked against the expected size, so a wrong field type shows as a size mismatch
 * instead of silently shifting every field after it.
 *
 * Usage (MSFS running):
 *   npx tsx scripts/spike-taxi-full.ts                 # VHHH, ZJSY, EGLL
 *   SPIKE_ICAOS=VHHH,RKSI npx tsx scripts/spike-taxi-full.ts
 * Writes release/spike/taxi-full/<ICAO>.json (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { open, Protocol, FacilityDataType, type RawBuffer } from 'node-simconnect'

const ICAOS = (process.env['SPIKE_ICAOS'] ?? 'VHHH,ZJSY,EGLL').split(',').map((s) => s.trim().toUpperCase())
const OUT_DIR = join(process.cwd(), 'release', 'spike', 'taxi-full')
const TIMEOUT_MS = 15 * 60_000

const DEF_ID = 40

const PATH_FIELDS: [string, 'i32' | 'u32' | 'f32'][] = [
  ['TYPE', 'i32'],
  ['WIDTH', 'f32'],
  ['LEFT_HALF_WIDTH', 'f32'],
  ['RIGHT_HALF_WIDTH', 'f32'],
  ['WEIGHT', 'u32'],
  ['RUNWAY_NUMBER', 'i32'],
  ['RUNWAY_DESIGNATOR', 'i32'],
  ['LEFT_EDGE', 'i32'],
  ['LEFT_EDGE_LIGHTED', 'i32'],
  ['RIGHT_EDGE', 'i32'],
  ['RIGHT_EDGE_LIGHTED', 'i32'],
  ['CENTER_LINE', 'i32'],
  ['CENTER_LINE_LIGHTED', 'i32'],
  ['START', 'i32'],
  ['END', 'i32'],
  ['NAME_INDEX', 'u32']
]
const POINT_FIELDS: [string, 'i32' | 'f32'][] = [
  ['TYPE', 'i32'],
  ['ORIENTATION', 'i32'],
  ['BIAS_X', 'f32'],
  ['BIAS_Z', 'f32']
]
const PARKING_FIELDS: [string, 'i32' | 'u32' | 'f32'][] = [
  ['TYPE', 'i32'],
  ['TAXI_POINT_TYPE', 'i32'],
  ['NAME', 'i32'],
  ['SUFFIX', 'i32'],
  ['NUMBER', 'u32'],
  ['ORIENTATION', 'i32'],
  ['HEADING', 'f32'],
  ['RADIUS', 'f32'],
  ['BIAS_X', 'f32'],
  ['BIAS_Z', 'f32']
]

function read(d: RawBuffer, fields: [string, 'i32' | 'u32' | 'f32'][]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, kind] of fields)
    out[name] = kind === 'f32' ? d.readFloat32() : kind === 'u32' ? d.readUint32() : d.readInt32()
  return out
}

interface Airport {
  icao: string
  latitude: number
  longitude: number
  points: Record<string, number>[]
  paths: Record<string, number>[]
  names: string[]
  parkings: Record<string, number>[]
  sizeMismatches: Record<string, number>
  elapsedMs: number
}

open('WingLog taxi-full spike', Protocol.SunRise)
  .then(({ handle }) => {
    const add = (field: string): void => {
      handle.addToFacilityDefinition(DEF_ID, field)
    }
    add('OPEN AIRPORT')
    add('ICAO')
    add('LATITUDE')
    add('LONGITUDE')
    add('N_TAXI_POINTS')
    add('N_TAXI_PATHS')
    add('N_TAXI_NAMES')
    add('N_TAXI_PARKINGS')
    add('OPEN TAXI_POINT')
    for (const [f] of POINT_FIELDS) add(f)
    add('CLOSE TAXI_POINT')
    add('OPEN TAXI_PATH')
    for (const [f] of PATH_FIELDS) add(f)
    add('CLOSE TAXI_PATH')
    add('OPEN TAXI_NAME')
    add('NAME')
    add('CLOSE TAXI_NAME')
    add('OPEN TAXI_PARKING')
    for (const [f] of PARKING_FIELDS) add(f)
    add('CLOSE TAXI_PARKING')
    add('CLOSE AIRPORT')

    mkdirSync(OUT_DIR, { recursive: true })
    const airports = new Map<number, Airport>()
    let pending = ICAOS.length
    ICAOS.forEach((icao, i) => {
      const requestId = 500 + i
      airports.set(requestId, {
        icao,
        latitude: 0,
        longitude: 0,
        points: [],
        paths: [],
        names: [],
        parkings: [],
        sizeMismatches: {},
        elapsedMs: Date.now()
      })
      console.log(`Requesting ${icao}...`)
      handle.requestFacilityData(DEF_ID, requestId, icao)
    })

    const check = (a: Airport, kind: string, d: RawBuffer): void => {
      const left = d.remaining()
      if (left !== 0) a.sizeMismatches[kind] = (a.sizeMismatches[kind] ?? 0) + 1
    }

    handle.on('facilityData', (r) => {
      const a = airports.get(r.userRequestId)
      if (!a) return
      const d = r.data
      switch (r.type) {
        case FacilityDataType.AIRPORT:
          a.icao = d.readString8()
          a.latitude = d.readFloat64()
          a.longitude = d.readFloat64()
          console.log(
            `${a.icao}: points ${d.readInt32()}, paths ${d.readInt32()}, names ${d.readInt32()}, parkings ${d.readInt32()}`
          )
          break
        case FacilityDataType.TAXI_POINT:
          a.points[r.itemIndex] = read(d, POINT_FIELDS)
          check(a, 'point', d)
          break
        case FacilityDataType.TAXI_PATH:
          a.paths[r.itemIndex] = read(d, PATH_FIELDS)
          check(a, 'path', d)
          break
        case FacilityDataType.TAXI_NAME:
          a.names[r.itemIndex] = d.readString32()
          check(a, 'name', d)
          break
        case FacilityDataType.TAXI_PARKING:
          a.parkings[r.itemIndex] = read(d, PARKING_FIELDS)
          check(a, 'parking', d)
          break
        default:
          break
      }
    })

    handle.on('facilityDataEnd', (r) => {
      const a = airports.get(r.userRequestId)
      if (!a) return
      a.elapsedMs = Date.now() - a.elapsedMs
      writeFileSync(join(OUT_DIR, `${a.icao}.json`), JSON.stringify(a))
      const types: Record<number, number> = {}
      for (const p of a.paths) if (p) types[p['TYPE'] ?? -1] = (types[p['TYPE'] ?? -1] ?? 0) + 1
      console.log(
        `${a.icao} done in ${a.elapsedMs} ms: ${a.points.length} points, ${a.paths.length} paths ${JSON.stringify(types)}, ` +
          `${a.names.length} names, ${a.parkings.length} parkings, size mismatches ${JSON.stringify(a.sizeMismatches)}`
      )
      if (--pending === 0) {
        handle.close()
        process.exit(0)
      }
    })

    handle.on('exception', (e) =>
      console.error(`SimConnect exception ${e.exceptionName} (index ${e.index}, sendId ${e.sendId})`)
    )
    setTimeout(() => {
      console.error('Timed out')
      process.exit(1)
    }, TIMEOUT_MS)
  })
  .catch((error: unknown) => {
    console.error('Connection failed:', error)
    process.exit(1)
  })
