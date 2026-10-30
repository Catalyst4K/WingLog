/**
 * Spike for the sim-traffic layer (winglog-backend docs/plans/vatsim-build.md, Step 4b): which aircraft does SimConnect list around the
 * user, with what ids, and does BeyondATC's traffic appear among them?
 *
 *   npx tsx --tsconfig tsconfig.node.json scripts/spike-sim-traffic.ts [minutes]
 *
 * Opens its own connection (never the tracking one), defines the position and ATC fields, and every 5 s asks for every aircraft within
 * 200 km (the SDK's maximum). Prints a summary per sweep and writes the raw sweeps to release/sim-traffic-spike/ (gitignored, local).
 * The user's own aircraft is told apart by the object id its own request returns.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  Protocol,
  SimConnectConstants,
  SimConnectDataType,
  SimConnectPeriod,
  SimObjectType,
  type RawBuffer
} from 'node-simconnect'
import { openSimConnect } from '../src/main/sim/open-simconnect'

const APP_NAME = 'WingLog sim-traffic spike'
const DEFINITION_ID = 1
const USER_REQUEST_ID = 10
const TRAFFIC_REQUEST_ID = 11
const RADIUS_M = 200_000
const SWEEP_INTERVAL_MS = 5_000
const OUT_DIR = join('release', 'sim-traffic-spike')

interface Field {
  name: string
  unit: string
  type: SimConnectDataType
}

/** Read in this order from each record. */
const FIELDS: Field[] = [
  { name: 'PLANE LATITUDE', unit: 'degrees', type: SimConnectDataType.FLOAT64 },
  { name: 'PLANE LONGITUDE', unit: 'degrees', type: SimConnectDataType.FLOAT64 },
  { name: 'PLANE ALTITUDE', unit: 'meters', type: SimConnectDataType.FLOAT64 },
  { name: 'PLANE HEADING DEGREES TRUE', unit: 'degrees', type: SimConnectDataType.FLOAT64 },
  { name: 'GROUND VELOCITY', unit: 'meters per second', type: SimConnectDataType.FLOAT64 },
  { name: 'SIM ON GROUND', unit: 'bool', type: SimConnectDataType.INT32 },
  { name: 'ATC ID', unit: '', type: SimConnectDataType.STRING32 },
  { name: 'ATC AIRLINE', unit: '', type: SimConnectDataType.STRING64 },
  { name: 'ATC FLIGHT NUMBER', unit: '', type: SimConnectDataType.STRING8 },
  { name: 'TITLE', unit: '', type: SimConnectDataType.STRING256 }
]

interface Record_ {
  objectId: number
  latitude: number
  longitude: number
  altitudeM: number
  headingDeg: number
  groundSpeedMs: number
  onGround: boolean
  atcId: string
  atcAirline: string
  atcFlightNumber: string
  title: string
}

function read(data: RawBuffer, objectId: number): Record_ {
  return {
    objectId,
    latitude: data.readFloat64(),
    longitude: data.readFloat64(),
    altitudeM: data.readFloat64(),
    headingDeg: data.readFloat64(),
    groundSpeedMs: data.readFloat64(),
    onGround: data.readInt32() === 1,
    atcId: data.readString32(),
    atcAirline: data.readString64(),
    atcFlightNumber: data.readString8(),
    title: data.readString256()
  }
}

async function main(): Promise<void> {
  const minutes = Number(process.argv[2] ?? 3)
  mkdirSync(OUT_DIR, { recursive: true })
  const outFile = join(OUT_DIR, `sweeps-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  const { recvOpen, handle } = await openSimConnect(APP_NAME, Protocol.SunRise)
  console.log(`Connected: ${recvOpen.applicationName}`)
  FIELDS.forEach((f, i) => handle.addToDataDefinition(DEFINITION_ID, f.name, f.unit, f.type, 0, i))

  let userObjectId: number | null = null
  let user: Record_ | null = null
  let sweep: Record_[] = []
  let sweepNumber = 0

  handle.on('simObjectData', (recv) => {
    if (recv.requestID !== USER_REQUEST_ID) return
    userObjectId = recv.objectID
    user = read(recv.data, recv.objectID)
  })
  handle.on('simObjectDataByType', (recv) => {
    if (recv.requestID !== TRAFFIC_REQUEST_ID) return
    sweep.push(read(recv.data, recv.objectID))
    if (recv.entryNumber === recv.outOf) finishSweep(recv.outOf)
  })
  handle.on('exception', (e) =>
    console.error(`SimConnect exception: ${e.exceptionName} (sendId ${e.sendId})`)
  )

  function finishSweep(outOf: number): void {
    sweepNumber++
    const others = sweep.filter((r) => r.objectId !== userObjectId)
    const named = others.filter((r) => r.atcId || r.atcAirline)
    console.log(
      `sweep ${sweepNumber}: ${sweep.length} listed (outOf ${outOf}), user object ${userObjectId}, ${others.length} others, ${named.length} with an ATC id`
    )
    for (const r of others.slice(0, 12))
      console.log(
        `  #${r.objectId} ${r.atcId || '-'} | ${r.atcAirline || '-'} ${r.atcFlightNumber || ''} | ${r.title.slice(0, 40)} | ${Math.round(r.altitudeM * 3.28084)} ft ${Math.round(r.groundSpeedMs * 1.94384)} kt ${r.onGround ? 'GND' : 'AIR'}`
      )
    appendFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), outOf, user, sweep }) + '\n')
    sweep = []
  }

  handle.requestDataOnSimObject(
    USER_REQUEST_ID,
    DEFINITION_ID,
    SimConnectConstants.OBJECT_ID_USER,
    SimConnectPeriod.SECOND
  )
  const timer = setInterval(
    () =>
      handle.requestDataOnSimObjectType(TRAFFIC_REQUEST_ID, DEFINITION_ID, RADIUS_M, SimObjectType.AIRCRAFT),
    SWEEP_INTERVAL_MS
  )
  await new Promise((resolve) => setTimeout(resolve, minutes * 60_000))
  clearInterval(timer)
  handle.close()
  console.log(`Done. Raw sweeps: ${outFile}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
