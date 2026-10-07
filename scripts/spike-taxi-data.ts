/**
 * Throwaway spike for Part 4 of winglog-backend's docs/plans/beyondatc-integration.md
 * (taxi route overlay on the map) — M1/M6 spike-first discipline: nothing gets designed from
 * the SimConnect SDK reference table alone, only from what this actually observes against a
 * live MSFS session. Real, specific unknowns this needs to answer (plan doc's own list):
 *
 * 1. How does a TAXI_NAME record correlate to the TAXI_PATH record(s) it names? The SDK
 *    reference doesn't say — "parallel array by index" (same position, same itemIndex) is
 *    the working guess, same shape as TAXI_PATH's own START/END referencing TAXI_POINT by
 *    index. Compare N_TAXI_PATHS vs N_TAXI_NAMES and each record's itemIndex in the logged
 *    output to check.
 * 2. TAXI_POINT has no LATITUDE/LONGITUDE — position is BIAS_X/BIAS_Z, metre offsets from
 *    the airport's own reference point (fetched here as AIRPORT.LATITUDE/LONGITUDE, the same
 *    field sim-facilities-fetch.ts already uses). Which axis is which (true north vs the
 *    airport's own reference heading) isn't confirmed — this script only captures the raw
 *    values; converting and checking them against a real taxiway diagram is a manual
 *    follow-up, not something to automate blind.
 * 3. Realistic record counts and response time for a large, complex airport — is this fast
 *    enough to fetch without a real UX problem, the same question Phase 2's facilities spike
 *    already answered for procedures.
 *
 * Field/count-field names below (N_TAXI_POINTS, OPEN TAXI_POINT, etc.) are educated guesses
 * following the exact naming convention RUNWAY/DEPARTURE/ARRIVAL already confirmed working
 * (docs/navdata-notes.md) — a wrong guess shows up as a SimConnect `exception` event below,
 * not a silent crash, same safety net spike-facilities.ts already relies on. Three separate
 * definitions (points / paths / names), not one nested one, so a bad guess in one doesn't
 * corrupt the others — same reasoning spike-facilities.ts gives for splitting runways from
 * procedures.
 *
 * Every parsed record is also appended as one JSON line to a log file (path printed on
 * startup) for after-the-fact analysis.
 *
 * Log every answer in winglog-backend's docs/beyondatc-notes.md before any Part 4 design
 * or code exists.
 *
 * Usage:
 *   npm run spike:taxi-data
 *   SPIKE_LOCAL_ICAO=EGKB npm run spike:taxi-data   # also fetch wherever you're parked
 * (SIMCONNECT_HOST/SIMCONNECT_PORT env vars for a remote sim — see spike-simconnect.ts.)
 */
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open, Protocol, FacilityDataType, type RawBuffer, type DataRequestId } from 'node-simconnect'

const APP_NAME = 'WingLog taxi-data spike'

const LOG_DIR = mkdtempSync(join(tmpdir(), 'winglog-taxi-spike-'))
const LOG_FILE = join(LOG_DIR, 'output.jsonl')
console.log(`Logging every parsed record to ${LOG_FILE}`)

function logRecord(kind: string, data: Record<string, unknown>): void {
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n')
}

function connectionOptions(): { remote: { host: string; port: number } } | undefined {
  const host = process.env['SIMCONNECT_HOST']
  const port = process.env['SIMCONNECT_PORT']
  if (!host || !port) return undefined
  return { remote: { host, port: Number(port) } }
}

// Large/complex on purpose (real record-count and timing question above), plus EGLL as a
// smaller comparison point and an optional wherever-you're-parked airport.
const TEST_ICAOS = [
  'VHHH',
  'EGLL',
  ...(process.env['SPIKE_LOCAL_ICAO'] ? [process.env['SPIKE_LOCAL_ICAO']] : [])
]

const enum DefId {
  TAXI_POINTS = 20,
  TAXI_PATHS = 21,
  TAXI_NAMES = 22
}

const requestIcao = new Map<DataRequestId, string>()
const requestDefId = new Map<DataRequestId, DefId>()
const uniqueRequestLabel = new Map<number, string>()
const requestStartedAt = new Map<DataRequestId, number>()
let nextRequestId = 200

function buildDefinitions(handle: Awaited<ReturnType<typeof open>>['handle']): void {
  // TAXI_POINTS — airport reference point (for converting BIAS_X/BIAS_Z later) + every taxi
  // point's raw TYPE/ORIENTATION/BIAS_X/BIAS_Z.
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'OPEN AIRPORT')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'ICAO')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'LATITUDE')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'LONGITUDE')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'N_TAXI_POINTS')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'OPEN TAXI_POINT')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'TYPE')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'ORIENTATION')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'BIAS_X')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'BIAS_Z')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'CLOSE TAXI_POINT')
  handle.addToFacilityDefinition(DefId.TAXI_POINTS, 'CLOSE AIRPORT')

  // TAXI_PATHS — TYPE (filter to TAXI=1 client-side, per the plan doc's catalogue of the
  // other values: RUNWAY/PARKING/PATH/CLOSED/VEHICLE/ROAD/PAINTEDLINE), WIDTH, START/END
  // (indices into the TAXI_POINT list above, not coordinates).
  handle.addToFacilityDefinition(DefId.TAXI_PATHS, 'OPEN AIRPORT')
  handle.addToFacilityDefinition(DefId.TAXI_PATHS, 'ICAO')
  handle.addToFacilityDefinition(DefId.TAXI_PATHS, 'N_TAXI_PATHS')
  handle.addToFacilityDefinition(DefId.TAXI_PATHS, 'OPEN TAXI_PATH')
  handle.addToFacilityDefinition(DefId.TAXI_PATHS, 'TYPE')
  handle.addToFacilityDefinition(DefId.TAXI_PATHS, 'WIDTH')
  handle.addToFacilityDefinition(DefId.TAXI_PATHS, 'START')
  handle.addToFacilityDefinition(DefId.TAXI_PATHS, 'END')
  handle.addToFacilityDefinition(DefId.TAXI_PATHS, 'CLOSE TAXI_PATH')
  handle.addToFacilityDefinition(DefId.TAXI_PATHS, 'CLOSE AIRPORT')

  // TAXI_NAMES — one field, NAME (e.g. "C", "W1"). Fetched as its own request so its
  // itemIndex sequence can be compared against TAXI_PATHS' own, independently.
  handle.addToFacilityDefinition(DefId.TAXI_NAMES, 'OPEN AIRPORT')
  handle.addToFacilityDefinition(DefId.TAXI_NAMES, 'ICAO')
  handle.addToFacilityDefinition(DefId.TAXI_NAMES, 'N_TAXI_NAMES')
  handle.addToFacilityDefinition(DefId.TAXI_NAMES, 'OPEN TAXI_NAME')
  handle.addToFacilityDefinition(DefId.TAXI_NAMES, 'NAME')
  handle.addToFacilityDefinition(DefId.TAXI_NAMES, 'CLOSE TAXI_NAME')
  handle.addToFacilityDefinition(DefId.TAXI_NAMES, 'CLOSE AIRPORT')
}

function requestAirport(
  handle: Awaited<ReturnType<typeof open>>['handle'],
  defId: DefId,
  kind: string,
  icao: string,
  region?: string
): void {
  const reqId = nextRequestId++
  requestIcao.set(reqId, `${icao} ${kind}`)
  requestDefId.set(reqId, defId)
  requestStartedAt.set(reqId, Date.now())
  console.log(`Requesting ${kind} for ${icao}${region ? ` (region ${region})` : ''}...`)
  handle.requestFacilityData(defId, reqId, icao, region)
}

function parentLabel(recvFacilityData: { parentUniqueRequestId: number }): string {
  return (
    uniqueRequestLabel.get(recvFacilityData.parentUniqueRequestId) ??
    `unknown-parent-${recvFacilityData.parentUniqueRequestId}`
  )
}

open(APP_NAME, Protocol.SunRise, connectionOptions())
  .then(({ recvOpen, handle }) => {
    console.log(
      `Connected: ${recvOpen.applicationName} (SimConnect ${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor})`
    )

    buildDefinitions(handle)
    console.log(`Requesting taxi data for: ${TEST_ICAOS.join(', ')}`)
    for (const icao of TEST_ICAOS) {
      requestAirport(handle, DefId.TAXI_POINTS, 'taxi-points', icao)
      requestAirport(handle, DefId.TAXI_PATHS, 'taxi-paths', icao)
      requestAirport(handle, DefId.TAXI_NAMES, 'taxi-names', icao)
    }

    handle.on('facilityData', (recvFacilityData) => {
      const label =
        requestIcao.get(recvFacilityData.userRequestId) ?? `request-${recvFacilityData.userRequestId}`
      const d: RawBuffer = recvFacilityData.data
      let parsed: Record<string, unknown>
      let ownLabel = label

      switch (recvFacilityData.type) {
        case FacilityDataType.AIRPORT: {
          const defId = requestDefId.get(recvFacilityData.userRequestId)
          parsed =
            defId === DefId.TAXI_POINTS
              ? { icao: d.readString8(), latitude: d.readFloat64(), longitude: d.readFloat64() }
              : { icao: d.readString8() }
          uniqueRequestLabel.set(recvFacilityData.uniqueRequestId, `${parsed.icao as string}`)
          ownLabel = `${parsed.icao as string} (${label})`
          break
        }
        case FacilityDataType.TAXI_POINT: {
          parsed = {
            type: d.readInt32(),
            orientationDeg: d.readFloat32(),
            biasX: d.readFloat32(),
            biasZ: d.readFloat32()
          }
          ownLabel = `${parentLabel(recvFacilityData)} POINT#${recvFacilityData.itemIndex}`
          break
        }
        case FacilityDataType.TAXI_PATH: {
          parsed = {
            type: d.readInt32(),
            widthM: d.readFloat32(),
            start: d.readInt32(),
            end: d.readInt32()
          }
          ownLabel = `${parentLabel(recvFacilityData)} PATH#${recvFacilityData.itemIndex}`
          break
        }
        case FacilityDataType.TAXI_NAME: {
          parsed = { name: d.readString8() }
          ownLabel = `${parentLabel(recvFacilityData)} NAME#${recvFacilityData.itemIndex}`
          break
        }
        default: {
          parsed = { note: 'unhandled FacilityDataType, not requested by this spike' }
        }
      }

      console.log(`[${ownLabel}] ${FacilityDataType[recvFacilityData.type]}`, parsed)
      logRecord('facility-data', {
        label: ownLabel,
        type: FacilityDataType[recvFacilityData.type],
        itemIndex: recvFacilityData.itemIndex,
        listSize: recvFacilityData.listSize,
        uniqueRequestId: recvFacilityData.uniqueRequestId,
        parentUniqueRequestId: recvFacilityData.parentUniqueRequestId,
        ...parsed
      })
    })

    handle.on('facilityDataEnd', (recvFacilityDataEnd) => {
      const label =
        requestIcao.get(recvFacilityDataEnd.userRequestId) ?? `request-${recvFacilityDataEnd.userRequestId}`
      const startedAt = requestStartedAt.get(recvFacilityDataEnd.userRequestId)
      const elapsedMs = startedAt ? Date.now() - startedAt : null
      console.log(`--- ${label} complete (${elapsedMs}ms) ---`)
      logRecord('facility-data-end', { label, elapsedMs })
    })

    handle.on('facilityMinimalList', (recvFacilityMinimalList) => {
      const label = requestIcao.get(recvFacilityMinimalList.requestID)
      console.log(
        `facilityMinimalList for ${label ?? recvFacilityMinimalList.requestID}:`,
        recvFacilityMinimalList.data
      )
      logRecord('facility-minimal-list', {
        label,
        candidates: recvFacilityMinimalList.data.map((f) => ({ ident: f.icao.ident, region: f.icao.region }))
      })
      if (!label || recvFacilityMinimalList.data.length === 0) return
      const [icao, kind] = label.split(' ')
      const defId = {
        'taxi-points': DefId.TAXI_POINTS,
        'taxi-paths': DefId.TAXI_PATHS,
        'taxi-names': DefId.TAXI_NAMES
      }[kind ?? '']
      if (!defId || !icao) return
      requestAirport(handle, defId, kind!, icao, recvFacilityMinimalList.data[0]!.icao.region)
    })

    handle.on('exception', (recvException) => {
      console.error(
        `SimConnect exception: ${recvException.exceptionName} (index ${recvException.index}, sendId ${recvException.sendId})`
      )
      logRecord('exception', {
        exceptionName: recvException.exceptionName,
        index: recvException.index,
        sendId: recvException.sendId
      })
    })

    handle.on('quit', () => {
      console.log('Sim quit.')
      process.exit(0)
    })
    handle.on('close', () => {
      console.log('Connection closed.')
      process.exit(0)
    })

    process.on('SIGINT', () => {
      console.log(`\nShutting down. Full log: ${LOG_FILE}`)
      handle.close()
      process.exit(0)
    })
  })
  .catch((error: unknown) => {
    console.error('Connection failed:', error)
    process.exit(1)
  })
