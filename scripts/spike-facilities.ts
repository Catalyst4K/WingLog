/**
 * Phase 2 throwaway spike for docs/plans/navdata-without-navigraph.md (flightdeck-backend)
 * — M1/M6 spike-first discipline: nothing in that plan's Phase 3 (a real NavdataProvider)
 * gets built from the plan doc's field-mapping table alone, only from what this actually
 * observes against a live MSFS 2024. Two independent halves, both need a real flight:
 *
 * 1. Runway/landing half — do the `ATC RUNWAY *` SimVars (assigned-runway geometry,
 *    aiming-point-relative position) populate and read sensibly through an approach,
 *    touchdown and rollout; does `ATC RUNWAY SELECTED` track ATC reassigning the runway;
 *    is `NAV LOC RUNWAY NUMBER`/`DESIGNATOR` populated on an ILS approach. Printed
 *    automatically whenever below 2000ft AGL or still rolling out after touchdown — no
 *    action needed beyond flying a normal approach.
 * 2. Procedures half — `requestFacilityData` for a small set of test airports (EGLL, VHHH,
 *    EGKK, plus an optional SPIKE_LOCAL_ICAO for wherever you're actually parked), fetching
 *    runways, departures and arrivals (full procedure trees) and approaches. Fires
 *    immediately on connect — doesn't need to be airborne. Split into four separate
 *    requests per airport (runways / departures / arrivals / approaches) rather than one
 *    giant nested definition, on purpose: the plan doc notes at least one MSFS DevSupport
 *    report of `RequestFacilityData` causing a CTD on a specific airport, and smaller
 *    independent requests make it possible to tell which one (if any) is the problem
 *    rather than losing the whole spike to one bad definition.
 *
 * Every parsed record is also appended as one JSON line to a log file (path printed on
 * startup) for after-the-fact analysis — the console output for a busy airport's full
 * departure/arrival tree runs to hundreds of lines.
 *
 * Log every answer in flightdeck-backend's docs/navdata-notes.md, mirroring
 * docs/simconnect-notes.md, before any Phase 3 code exists.
 *
 * Usage:
 *   npm run spike:facilities
 *   SPIKE_LOCAL_ICAO=EGKB npm run spike:facilities   # also fetch wherever you're parked
 * (SIMCONNECT_HOST/SIMCONNECT_PORT env vars for a remote sim — see spike-simconnect.ts.)
 */
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  open,
  Protocol,
  SimConnectConstants,
  SimConnectDataType,
  SimConnectPeriod,
  FacilityDataType,
  type RawBuffer,
  type DataRequestId
} from 'node-simconnect'

const APP_NAME = 'WingLog navdata spike'

// -----------------------------------------------------------------------------------------
// Output log — every parsed record, one JSON line each, independent of the console output.
// -----------------------------------------------------------------------------------------
const LOG_DIR = mkdtempSync(join(tmpdir(), 'winglog-navdata-spike-'))
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

// -----------------------------------------------------------------------------------------
// Part 1 — runway/landing SimVars (docs/plans/navdata-without-navigraph.md, Finding 2)
// -----------------------------------------------------------------------------------------
const SIMVAR_DEFINITION_ID = 0
const SIMVAR_REQUEST_ID = 0

interface SimVarSpec {
  name: string
  unit: string | null
  dataType: SimConnectDataType
  read: (data: RawBuffer) => number | boolean | string
}

const asBool = (data: RawBuffer): boolean => data.readInt32() === 1

// Unconfirmed until this spike actually runs: whether these populate at all, whether
// TDPOINT RELATIVE POSITION reads sensibly, and whether ATC RUNWAY SELECTED tracks a
// reassignment. SIM ON GROUND / GROUND VELOCITY / PLANE ALT ABOVE GROUND gate when this
// prints (see shouldPrint below), not something the landing feature itself needs.
const SIM_VARS: SimVarSpec[] = [
  { name: 'SIM ON GROUND', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool },
  { name: 'PLANE ALT ABOVE GROUND', unit: 'feet', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { name: 'GROUND VELOCITY', unit: 'knots', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { name: 'ATC RUNWAY SELECTED', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool },
  { name: 'ATC RUNWAY HEADING DEGREES TRUE', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { name: 'ATC RUNWAY LENGTH', unit: 'meters', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { name: 'ATC RUNWAY WIDTH', unit: 'meters', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { name: 'ATC RUNWAY RELATIVE POSITION X', unit: 'meters', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { name: 'ATC RUNWAY RELATIVE POSITION Z', unit: 'meters', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  {
    name: 'ATC RUNWAY TDPOINT RELATIVE POSITION X',
    unit: 'meters',
    dataType: SimConnectDataType.FLOAT64,
    read: (d) => d.readFloat64()
  },
  {
    name: 'ATC RUNWAY TDPOINT RELATIVE POSITION Z',
    unit: 'meters',
    dataType: SimConnectDataType.FLOAT64,
    read: (d) => d.readFloat64()
  },
  { name: 'ATC RUNWAY START DISTANCE', unit: 'meters', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  // Unconfirmed type — treated as a plain number (matches FLAPS HANDLE INDEX's pattern in
  // spike-simconnect.ts). Watch the exception handler below: if these two names are wrong,
  // that answers the "is it populated at all" question on its own, the same way the
  // original M1 spike found SIM RATE -> SIMULATION RATE.
  { name: 'NAV LOC RUNWAY NUMBER:1', unit: 'number', dataType: SimConnectDataType.INT32, read: (d) => d.readInt32() },
  { name: 'NAV LOC RUNWAY DESIGNATOR:1', unit: 'number', dataType: SimConnectDataType.INT32, read: (d) => d.readInt32() }
]

function maybePrintRunwaySimVars(values: Record<string, number | boolean | string>): void {
  const onGround = values['SIM ON GROUND'] as boolean
  const altAglFt = values['PLANE ALT ABOVE GROUND'] as number
  const groundKt = values['GROUND VELOCITY'] as number

  // Approach (below 2000ft AGL) or still rolling out after touchdown (on the ground and
  // faster than taxi speed) — silent the rest of the flight so cruise doesn't spam the
  // console for however long this runs.
  const rollingOut = onGround && groundKt > 5
  const shouldPrint = altAglFt < 2000 || rollingOut

  if (!shouldPrint) return
  console.log(new Date().toISOString(), values)
  logRecord('simvar-tick', { values })
}

// -----------------------------------------------------------------------------------------
// Part 2 — procedures (docs/plans/navdata-without-navigraph.md, Finding 3)
// -----------------------------------------------------------------------------------------

// One definition id per record shape, reused across every test airport — the ICAO is
// supplied per requestFacilityData call, not baked into the definition.
const enum DefId {
  RUNWAYS = 10,
  DEPARTURES = 11,
  ARRIVALS = 12,
  APPROACHES = 13
}

const TEST_ICAOS = ['EGLL', 'VHHH', 'EGKK', ...(process.env['SPIKE_LOCAL_ICAO'] ? [process.env['SPIKE_LOCAL_ICAO']] : [])]

// Shared leg field list — identical layout for APPROACH_LEG, FINAL_APPROACH_LEG and
// MISSED_APPROACH_LEG (confirmed via the MSFS 2024 SDK's Facility Data Definition
// reference), so one field list serves all three FacilityDataType values. A deliberate
// subset of the ~38 real fields — just what sid-star-selection.md's DFD-equivalence table
// (docs/plans/navdata-without-navigraph.md) actually needs.
function addLegFields(addField: (name: string) => void): void {
  addField('TYPE')
  addField('FIX_ICAO')
  addField('FIX_REGION')
  addField('FIX_TYPE')
  addField('FIX_LATITUDE')
  addField('FIX_LONGITUDE')
  addField('FIX_ALTITUDE')
  addField('TURN_DIRECTION')
  addField('COURSE')
  addField('ALTITUDE1')
  addField('ALTITUDE2')
  addField('SPEED_LIMIT')
}

function readLeg(d: RawBuffer): Record<string, unknown> {
  return {
    type: d.readInt32(),
    fixIcao: d.readString8(),
    fixRegion: d.readString8(),
    fixType: d.readInt32(),
    fixLatitude: d.readFloat64(),
    fixLongitude: d.readFloat64(),
    fixAltitude: d.readFloat64(),
    turnDirection: d.readInt32(),
    courseDeg: d.readFloat32(),
    altitude1: d.readFloat32(),
    altitude2: d.readFloat32(),
    speedLimit: d.readFloat32()
  }
}

// requestId -> a human-readable label ("EGLL", "EGLL DEP#0 SHOREHAM1A", ...), and
// uniqueRequestId -> the same, so a child record (a RUNWAY_TRANSITION, an APPROACH_LEG)
// can describe which parent it belongs to via RecvFacilityData's parentUniqueRequestId —
// this is purely for readable logging, the real provider (Phase 3) won't need it.
const requestIcao = new Map<DataRequestId, string>()
// Which definition a request was made against — the AIRPORT record's field list differs
// per definition (only RUNWAYS registers LATITUDE/LONGITUDE/NAME at the airport level;
// DEPARTURES/ARRIVALS/APPROACHES only register ICAO + their own count field), so the
// AIRPORT case in the facilityData handler below needs this to know which fields are
// actually present in that message's buffer.
const requestDefId = new Map<DataRequestId, DefId>()
const uniqueRequestLabel = new Map<number, string>()
const requestStartedAt = new Map<DataRequestId, number>()
let nextRequestId = 100

function buildDefinitions(
  handle: Awaited<ReturnType<typeof open>>['handle']
): void {
  // RUNWAYS — AIRPORT core fields + full runway list. Answers: does RUNWAY.LATITUDE/
  // LONGITUDE read as the runway centre (vs. vendored resources/runways.csv's threshold
  // lat/lon) — compare live output against known real values by hand.
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'OPEN AIRPORT')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'ICAO')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'LATITUDE')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'LONGITUDE')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'NAME')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'N_RUNWAYS')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'OPEN RUNWAY')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'LATITUDE')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'LONGITUDE')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'ALTITUDE')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'HEADING')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'LENGTH')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'WIDTH')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'SURFACE')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'PRIMARY_NUMBER')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'PRIMARY_DESIGNATOR')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'PRIMARY_ILS_ICAO')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'PRIMARY_ILS_REGION')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'SECONDARY_NUMBER')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'SECONDARY_DESIGNATOR')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'SECONDARY_ILS_ICAO')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'SECONDARY_ILS_REGION')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'CLOSE RUNWAY')
  handle.addToFacilityDefinition(DefId.RUNWAYS, 'CLOSE AIRPORT')

  // DEPARTURES / ARRIVALS — identical shape (DEPARTURE and ARRIVAL share the same direct
  // members and the same three child-struct types per the SDK reference), built once and
  // reused for both definition ids.
  function addProcedureTree(defId: DefId, kind: 'DEPARTURE' | 'ARRIVAL'): void {
    handle.addToFacilityDefinition(defId, 'OPEN AIRPORT')
    handle.addToFacilityDefinition(defId, 'ICAO')
    handle.addToFacilityDefinition(defId, kind === 'DEPARTURE' ? 'N_DEPARTURES' : 'N_ARRIVALS')
    handle.addToFacilityDefinition(defId, `OPEN ${kind}`)
    handle.addToFacilityDefinition(defId, 'NAME')
    handle.addToFacilityDefinition(defId, 'N_RUNWAY_TRANSITIONS')
    handle.addToFacilityDefinition(defId, 'N_ENROUTE_TRANSITIONS')
    handle.addToFacilityDefinition(defId, 'N_APPROACH_LEGS')
    handle.addToFacilityDefinition(defId, 'OPEN RUNWAY_TRANSITION')
    handle.addToFacilityDefinition(defId, 'RUNWAY_NUMBER')
    handle.addToFacilityDefinition(defId, 'RUNWAY_DESIGNATOR')
    handle.addToFacilityDefinition(defId, 'N_APPROACH_LEGS')
    handle.addToFacilityDefinition(defId, 'CLOSE RUNWAY_TRANSITION')
    handle.addToFacilityDefinition(defId, 'OPEN ENROUTE_TRANSITION')
    handle.addToFacilityDefinition(defId, 'NAME')
    handle.addToFacilityDefinition(defId, 'N_APPROACH_LEGS')
    handle.addToFacilityDefinition(defId, 'CLOSE ENROUTE_TRANSITION')
    handle.addToFacilityDefinition(defId, 'OPEN APPROACH_LEG')
    addLegFields((name) => handle.addToFacilityDefinition(defId, name))
    handle.addToFacilityDefinition(defId, 'CLOSE APPROACH_LEG')
    handle.addToFacilityDefinition(defId, `CLOSE ${kind}`)
    handle.addToFacilityDefinition(defId, 'CLOSE AIRPORT')
  }
  addProcedureTree(DefId.DEPARTURES, 'DEPARTURE')
  addProcedureTree(DefId.ARRIVALS, 'ARRIVAL')

  // APPROACHES — TYPE's real integer values are exactly what's unconfirmed (plan doc:
  // "what integer values does APPROACH_LEG.TYPE take and what do they map to").
  handle.addToFacilityDefinition(DefId.APPROACHES, 'OPEN AIRPORT')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'ICAO')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'N_APPROACHES')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'OPEN APPROACH')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'TYPE')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'SUFFIX')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'RUNWAY_NUMBER')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'RUNWAY_DESIGNATOR')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'N_TRANSITIONS')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'N_FINAL_APPROACH_LEGS')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'N_MISSED_APPROACH_LEGS')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'OPEN APPROACH_TRANSITION')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'NAME')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'TYPE')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'N_APPROACH_LEGS')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'CLOSE APPROACH_TRANSITION')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'OPEN FINAL_APPROACH_LEG')
  addLegFields((name) => handle.addToFacilityDefinition(DefId.APPROACHES, name))
  handle.addToFacilityDefinition(DefId.APPROACHES, 'CLOSE FINAL_APPROACH_LEG')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'OPEN MISSED_APPROACH_LEG')
  addLegFields((name) => handle.addToFacilityDefinition(DefId.APPROACHES, name))
  handle.addToFacilityDefinition(DefId.APPROACHES, 'CLOSE MISSED_APPROACH_LEG')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'CLOSE APPROACH')
  handle.addToFacilityDefinition(DefId.APPROACHES, 'CLOSE AIRPORT')
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
  return uniqueRequestLabel.get(recvFacilityData.parentUniqueRequestId) ?? `unknown-parent-${recvFacilityData.parentUniqueRequestId}`
}

// -----------------------------------------------------------------------------------------
// Connect
// -----------------------------------------------------------------------------------------
open(APP_NAME, Protocol.SunRise, connectionOptions())
  .then(({ recvOpen, handle }) => {
    console.log(`Connected: ${recvOpen.applicationName} (SimConnect ${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor})`)

    // Part 1: SimVar telemetry, always running in the background.
    for (const [index, spec] of SIM_VARS.entries()) {
      handle.addToDataDefinition(SIMVAR_DEFINITION_ID, spec.name, spec.unit, spec.dataType, 0, index)
    }
    handle.requestDataOnSimObject(SIMVAR_REQUEST_ID, SIMVAR_DEFINITION_ID, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND)
    handle.on('simObjectData', (recvSimObjectData) => {
      if (recvSimObjectData.requestID !== SIMVAR_REQUEST_ID) return
      const values: Record<string, number | boolean | string> = {}
      for (const spec of SIM_VARS) values[spec.name] = spec.read(recvSimObjectData.data)
      maybePrintRunwaySimVars(values)
    })

    // Part 2: procedures, fired immediately — doesn't need to be airborne.
    buildDefinitions(handle)
    console.log(`Requesting facility data for: ${TEST_ICAOS.join(', ')}`)
    for (const icao of TEST_ICAOS) {
      requestAirport(handle, DefId.RUNWAYS, 'runways', icao)
      requestAirport(handle, DefId.DEPARTURES, 'departures', icao)
      requestAirport(handle, DefId.ARRIVALS, 'arrivals', icao)
      requestAirport(handle, DefId.APPROACHES, 'approaches', icao)
    }

    handle.on('facilityData', (recvFacilityData) => {
      const label = requestIcao.get(recvFacilityData.userRequestId) ?? `request-${recvFacilityData.userRequestId}`
      const d = recvFacilityData.data
      let parsed: Record<string, unknown>
      let ownLabel = label

      switch (recvFacilityData.type) {
        case FacilityDataType.AIRPORT: {
          // Only RUNWAYS registers LATITUDE/LONGITUDE/NAME at the airport level —
          // DEPARTURES/ARRIVALS/APPROACHES only register ICAO + their own N_* count field,
          // so this message's buffer literally doesn't contain those bytes for those three.
          // (First real finding of this spike, the hard way: reading fields a definition
          // never registered overruns the buffer — RangeError, not silently wrong data.)
          const defId = requestDefId.get(recvFacilityData.userRequestId)
          parsed =
            defId === DefId.RUNWAYS
              ? {
                  icao: d.readString8(),
                  latitude: d.readFloat64(),
                  longitude: d.readFloat64(),
                  name: d.readString32()
                }
              : { icao: d.readString8() }
          uniqueRequestLabel.set(recvFacilityData.uniqueRequestId, `${parsed.icao as string}`)
          ownLabel = `${parsed.icao as string} (${label})`
          break
        }
        case FacilityDataType.RUNWAY: {
          parsed = {
            latitude: d.readFloat64(),
            longitude: d.readFloat64(),
            altitude: d.readFloat64(),
            headingDeg: d.readFloat32(),
            lengthM: d.readFloat32(),
            widthM: d.readFloat32(),
            surface: d.readInt32(),
            primaryNumber: d.readInt32(),
            primaryDesignator: d.readInt32(),
            primaryIlsIcao: d.readString8(),
            primaryIlsRegion: d.readString8(),
            secondaryNumber: d.readInt32(),
            secondaryDesignator: d.readInt32(),
            secondaryIlsIcao: d.readString8(),
            secondaryIlsRegion: d.readString8()
          }
          break
        }
        case FacilityDataType.DEPARTURE:
        case FacilityDataType.ARRIVAL: {
          parsed = {
            name: d.readString8(),
            nRunwayTransitions: d.readInt32(),
            nEnrouteTransitions: d.readInt32(),
            nApproachLegs: d.readInt32()
          }
          const label2 = `${parentLabel(recvFacilityData)} ${recvFacilityData.type === FacilityDataType.DEPARTURE ? 'DEP' : 'ARR'}#${recvFacilityData.itemIndex} ${parsed.name as string}`
          uniqueRequestLabel.set(recvFacilityData.uniqueRequestId, label2)
          ownLabel = label2
          break
        }
        case FacilityDataType.RUNWAY_TRANSITION: {
          parsed = { runwayNumber: d.readInt32(), runwayDesignator: d.readInt32(), nApproachLegs: d.readInt32() }
          const label2 = `${parentLabel(recvFacilityData)} RWYTRANS ${parsed.runwayNumber}${parsed.runwayDesignator}`
          uniqueRequestLabel.set(recvFacilityData.uniqueRequestId, label2)
          ownLabel = label2
          break
        }
        case FacilityDataType.ENROUTE_TRANSITION: {
          parsed = { name: d.readString8(), nApproachLegs: d.readInt32() }
          const label2 = `${parentLabel(recvFacilityData)} ENRTRANS ${parsed.name as string}`
          uniqueRequestLabel.set(recvFacilityData.uniqueRequestId, label2)
          ownLabel = label2
          break
        }
        case FacilityDataType.APPROACH: {
          parsed = {
            type: d.readInt32(),
            suffix: d.readInt32(),
            runwayNumber: d.readInt32(),
            runwayDesignator: d.readInt32(),
            nTransitions: d.readInt32(),
            nFinalApproachLegs: d.readInt32(),
            nMissedApproachLegs: d.readInt32()
          }
          const label2 = `${parentLabel(recvFacilityData)} APP#${recvFacilityData.itemIndex} type=${parsed.type} rwy=${parsed.runwayNumber}${parsed.runwayDesignator}`
          uniqueRequestLabel.set(recvFacilityData.uniqueRequestId, label2)
          ownLabel = label2
          break
        }
        case FacilityDataType.APPROACH_TRANSITION: {
          parsed = { name: d.readString8(), type: d.readInt32(), nApproachLegs: d.readInt32() }
          const label2 = `${parentLabel(recvFacilityData)} APPTRANS ${parsed.name as string}`
          uniqueRequestLabel.set(recvFacilityData.uniqueRequestId, label2)
          ownLabel = label2
          break
        }
        case FacilityDataType.APPROACH_LEG:
        case FacilityDataType.FINAL_APPROACH_LEG:
        case FacilityDataType.MISSED_APPROACH_LEG: {
          parsed = readLeg(d)
          ownLabel = `${parentLabel(recvFacilityData)} LEG#${recvFacilityData.itemIndex}`
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
      const label = requestIcao.get(recvFacilityDataEnd.userRequestId) ?? `request-${recvFacilityDataEnd.userRequestId}`
      const startedAt = requestStartedAt.get(recvFacilityDataEnd.userRequestId)
      const elapsedMs = startedAt ? Date.now() - startedAt : null
      console.log(`--- ${label} complete (${elapsedMs}ms) ---`)
      logRecord('facility-data-end', { label, elapsedMs })
    })

    // Duplicate-ICAO handling: SimConnect answers with a minimal candidate list instead of
    // facilityData when the ICAO is ambiguous. Retry with the first candidate's region.
    handle.on('facilityMinimalList', (recvFacilityMinimalList) => {
      const label = requestIcao.get(recvFacilityMinimalList.requestID)
      console.log(`facilityMinimalList for ${label ?? recvFacilityMinimalList.requestID}:`, recvFacilityMinimalList.data)
      logRecord('facility-minimal-list', {
        label,
        candidates: recvFacilityMinimalList.data.map((f) => ({ ident: f.icao.ident, region: f.icao.region }))
      })
      if (!label || recvFacilityMinimalList.data.length === 0) return
      const [icao, kind] = label.split(' ')
      const defId = { runways: DefId.RUNWAYS, departures: DefId.DEPARTURES, arrivals: DefId.ARRIVALS, approaches: DefId.APPROACHES }[
        kind ?? ''
      ]
      if (!defId || !icao) return
      requestAirport(handle, defId, kind!, icao, recvFacilityMinimalList.data[0]!.icao.region)
    })

    handle.on('exception', (recvException) => {
      console.error(`SimConnect exception: ${recvException.exceptionName} (index ${recvException.index}, sendId ${recvException.sendId})`)
      logRecord('exception', { exceptionName: recvException.exceptionName, index: recvException.index, sendId: recvException.sendId })
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
