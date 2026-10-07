/**
 * Reads an airport's navdata from MSFS through the SimConnect Facilities API: runways, procedures,
 * the taxi network and stands. Each fetch runs on a connection the caller opened and owns
 * (SimFacilitiesProvider), never on the live tracking connection.
 */
import {
  FacilityDataType,
  RawBuffer,
  type SimConnectConnection,
  type RecvException,
  type RecvFacilityData,
  type RecvFacilityDataEnd,
  type RecvFacilityMinimalList
} from 'node-simconnect'
import {
  NavdataDefId,
  addRunwayFields,
  addProcedureTreeDefinition,
  addApproachTreeDefinition,
  addAirportIcaoLatLonFields,
  addTaxiPointFields,
  addTaxiPathFields,
  addTaxiNameFields,
  addTaxiParkingFields,
  parseAirportHeader,
  parseAirportHeaderWithLatLon,
  parseRunway,
  parseProcedureHeader,
  parseRunwayTransition,
  parseEnrouteTransition,
  parseApproachHeader,
  parseApproachTransition,
  parseLeg,
  parseTaxiPoint,
  parseTaxiPath,
  parseTaxiName,
  parseTaxiParking,
  standLabel,
  biasToLatLon,
  type ParsedRunway,
  type ParsedLeg
} from '../sim/facility-fields'

/**
 * Issues one runway + one departure + one arrival facility request for a single airport on
 * an already-open SimConnect connection, and resolves once all three complete. Deliberately
 * takes a connection rather than opening its own — see sim-facilities-provider.ts, which
 * owns a short-lived, dedicated connection per fetch so this never shares a wire with
 * SimConnectService's live tracking stream (winglog-backend's docs/navdata-notes.md:
 * a heavy facility fetch stalled live telemetry for ~12.5s when the two shared one
 * connection during the Phase 2 spike).
 */

export interface FetchedRunwayTransition {
  runwayIdent: string
  legs: ParsedLeg[]
}

export interface FetchedEnrouteTransition {
  name: string
  legs: ParsedLeg[]
}

export interface FetchedProcedure {
  name: string
  runwayTransitions: FetchedRunwayTransition[]
  enrouteTransitions: FetchedEnrouteTransition[]
  /** Legs registered directly on the procedure, outside any transition — confirmed live,
   *  2026-09-08, that this is where EGLL's STARs (zero transitions each) put every real
   *  leg, while EGLL/VHHH's SIDs put theirs inside their one runway transition instead and
   *  leave this empty — see facility-fields.ts's module doc comment. */
  commonLegs: ParsedLeg[]
  /** The procedure header's own N_RUNWAY_TRANSITIONS/N_ENROUTE_TRANSITIONS/N_APPROACH_LEGS
   *  counts, kept alongside the arrays above so a caller can tell "the sim reported none"
   *  apart from "some got dropped while parsing" — e.g. scripts/spike-navdata-provider.ts's
   *  live diagnostic. */
  expected: { runwayTransitions: number; enrouteTransitions: number; approachLegs: number }
}

export interface FetchedApproachTransition {
  name: string
  legs: ParsedLeg[]
}

export interface FetchedApproach {
  /** Constructed display identifier, e.g. "ILS 07C" — see ParsedApproachHeader. */
  identifier: string
  runwayIdent: string
  transitions: FetchedApproachTransition[]
  /** The approach's own final segment — always common to every transition, per real ARINC
   *  424 shape confirmed live 2026-09-08 (docs/navdata-notes.md): a transition's own last
   *  leg and this list's first leg are the same fix, duplicated across both — a caller
   *  assembling a flyable path needs to drop that repeat, not something fetched here. */
  finalLegs: ParsedLeg[]
  expected: { transitions: number; finalApproachLegs: number; missedApproachLegs: number }
}

export interface FetchedAirportNavdata {
  icao: string
  runways: ParsedRunway[]
  departures: FetchedProcedure[]
  arrivals: FetchedProcedure[]
  approaches: FetchedApproach[]
}

const FETCH_TIMEOUT_MS = 20_000

function buildDefinitions(handle: SimConnectConnection): void {
  handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, 'OPEN AIRPORT')
  handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, 'ICAO')
  addRunwayFields((name) => handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, name))
  handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, 'CLOSE AIRPORT')

  const addField = (defId: NavdataDefId, name: string): void => {
    handle.addToFacilityDefinition(defId, name)
  }
  addProcedureTreeDefinition(addField, NavdataDefId.DEPARTURES, 'DEPARTURE')
  addProcedureTreeDefinition(addField, NavdataDefId.ARRIVALS, 'ARRIVAL')
  addApproachTreeDefinition(addField)
}

/**
 * Fetches an airport's runways and procedures. Runs on a connection the caller opened, never the
 * live tracking one: a heavy facility fetch stalls live telemetry for as long as it takes
 * (docs/navdata-notes.md).
 *
 * @param handle An open SimConnect connection the caller owns.
 * @param icao The airport.
 * @returns The runways, SIDs, STARs and approaches.
 * @throws When the sim reports an exception or the fetch times out.
 */
export function fetchAirportNavdata(handle: SimConnectConnection, icao: string): Promise<FetchedAirportNavdata> {
  buildDefinitions(handle)

  return new Promise((resolve, reject) => {
    const runways: ParsedRunway[] = []
    const departures: FetchedProcedure[] = []
    const arrivals: FetchedProcedure[] = []
    const approaches: FetchedApproach[] = []
    // A RUNWAY_TRANSITION/ENROUTE_TRANSITION/APPROACH_TRANSITION/APPROACH_LEG record only
    // carries its parent's uniqueRequestId (RecvFacilityData.parentUniqueRequestId), not
    // which array it belongs in — these maps track that link. An APPROACH_LEG's parent is
    // always one of its approach's transitions (an approach registers no top-level
    // APPROACH_LEG of its own, only FINAL_APPROACH_LEG); a DEPARTURE/ARRIVAL's own
    // APPROACH_LEG can be either a procedure directly (a common leg) or one of its
    // transitions — checked in that order below since transitionByUniqueRequestId is the
    // more specific match when both could apply.
    const procedureByUniqueRequestId = new Map<number, FetchedProcedure>()
    const transitionByUniqueRequestId = new Map<number, { legs: ParsedLeg[] }>()
    const approachByUniqueRequestId = new Map<number, FetchedApproach>()
    const pending = new Set<NavdataDefId>([
      NavdataDefId.RUNWAYS,
      NavdataDefId.DEPARTURES,
      NavdataDefId.ARRIVALS,
      NavdataDefId.APPROACHES
    ])
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timeoutTimer)
      handle.removeListener('facilityData', onFacilityData)
      handle.removeListener('facilityDataEnd', onFacilityDataEnd)
      handle.removeListener('facilityMinimalList', onFacilityMinimalList)
      handle.removeListener('exception', onException)
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ icao, runways, departures, arrivals, approaches })
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    function onFacilityData(recv: RecvFacilityData): void {
      const d = recv.data
      switch (recv.type) {
        case FacilityDataType.AIRPORT: {
          // Every definition here registers only ICAO at the airport level — no
          // LATITUDE/LONGITUDE/NAME anywhere — so this record's shape is uniform across
          // all three requests, sidestepping the per-definition buffer-shape gotcha the
          // Phase 2 spike found (docs/navdata-notes.md).
          parseAirportHeader(d)
          break
        }
        case FacilityDataType.RUNWAY: {
          runways.push(parseRunway(d))
          break
        }
        case FacilityDataType.DEPARTURE:
        case FacilityDataType.ARRIVAL: {
          const header = parseProcedureHeader(d)
          const procedure: FetchedProcedure = {
            name: header.name,
            runwayTransitions: [],
            enrouteTransitions: [],
            commonLegs: [],
            expected: {
              runwayTransitions: header.nRunwayTransitions,
              enrouteTransitions: header.nEnrouteTransitions,
              approachLegs: header.nApproachLegs
            }
          }
          ;(recv.userRequestId === NavdataDefId.DEPARTURES ? departures : arrivals).push(procedure)
          procedureByUniqueRequestId.set(recv.uniqueRequestId, procedure)
          break
        }
        case FacilityDataType.RUNWAY_TRANSITION: {
          const parsed = parseRunwayTransition(d)
          const parent = procedureByUniqueRequestId.get(recv.parentUniqueRequestId)
          if (!parent) break
          const transition: FetchedRunwayTransition = { runwayIdent: parsed.runwayIdent, legs: [] }
          parent.runwayTransitions.push(transition)
          transitionByUniqueRequestId.set(recv.uniqueRequestId, transition)
          break
        }
        case FacilityDataType.ENROUTE_TRANSITION: {
          const parsed = parseEnrouteTransition(d)
          const parent = procedureByUniqueRequestId.get(recv.parentUniqueRequestId)
          if (!parent) break
          const transition: FetchedEnrouteTransition = { name: parsed.name, legs: [] }
          parent.enrouteTransitions.push(transition)
          transitionByUniqueRequestId.set(recv.uniqueRequestId, transition)
          break
        }
        case FacilityDataType.APPROACH_LEG: {
          const leg = parseLeg(d)
          const transitionParent = transitionByUniqueRequestId.get(recv.parentUniqueRequestId)
          if (transitionParent) {
            transitionParent.legs.push(leg)
            break
          }
          const procedureParent = procedureByUniqueRequestId.get(recv.parentUniqueRequestId)
          procedureParent?.commonLegs.push(leg)
          break
        }
        case FacilityDataType.APPROACH: {
          const header = parseApproachHeader(d)
          const approach: FetchedApproach = {
            identifier: header.identifier,
            runwayIdent: header.runwayIdent,
            transitions: [],
            finalLegs: [],
            expected: {
              transitions: header.nTransitions,
              finalApproachLegs: header.nFinalApproachLegs,
              missedApproachLegs: header.nMissedApproachLegs
            }
          }
          approaches.push(approach)
          approachByUniqueRequestId.set(recv.uniqueRequestId, approach)
          break
        }
        case FacilityDataType.APPROACH_TRANSITION: {
          const parsed = parseApproachTransition(d)
          const parent = approachByUniqueRequestId.get(recv.parentUniqueRequestId)
          if (!parent) break
          const transition: FetchedApproachTransition = { name: parsed.name, legs: [] }
          parent.transitions.push(transition)
          transitionByUniqueRequestId.set(recv.uniqueRequestId, transition)
          break
        }
        case FacilityDataType.FINAL_APPROACH_LEG: {
          const leg = parseLeg(d)
          const approachParent = approachByUniqueRequestId.get(recv.parentUniqueRequestId)
          approachParent?.finalLegs.push(leg)
          break
        }
        default:
          break
      }
    }

    function onFacilityDataEnd(recv: RecvFacilityDataEnd): void {
      pending.delete(recv.userRequestId as NavdataDefId)
      if (pending.size === 0) finish()
    }

    function onFacilityMinimalList(recv: RecvFacilityMinimalList): void {
      // Ambiguous ICAO (duplicate across regions) — SimConnect answers with a minimal
      // candidate list instead of facilityData. Retry once with the first candidate's
      // region, same recovery the Phase 2 spike used (unverified live — never fired
      // against EGLL/VHHH/EGKK, all three resolved unambiguously — but per the documented
      // SDK contract).
      const defId = recv.requestID as NavdataDefId
      const region = recv.data[0]?.icao.region
      if (!pending.has(defId) || !region) return
      handle.requestFacilityData(defId, defId, icao, region)
    }

    function onException(recv: RecvException): void {
      fail(new Error(`SimConnect exception fetching ${icao} navdata: ${recv.exceptionName} (index ${recv.index})`))
    }

    handle.on('facilityData', onFacilityData)
    handle.on('facilityDataEnd', onFacilityDataEnd)
    handle.on('facilityMinimalList', onFacilityMinimalList)
    handle.on('exception', onException)

    const timeoutTimer = setTimeout(() => fail(new Error(`Facility fetch for ${icao} timed out`)), FETCH_TIMEOUT_MS)

    handle.requestFacilityData(NavdataDefId.RUNWAYS, NavdataDefId.RUNWAYS, icao)
    handle.requestFacilityData(NavdataDefId.DEPARTURES, NavdataDefId.DEPARTURES, icao)
    handle.requestFacilityData(NavdataDefId.ARRIVALS, NavdataDefId.ARRIVALS, icao)
    handle.requestFacilityData(NavdataDefId.APPROACHES, NavdataDefId.APPROACHES, icao)
  })
}

export interface FetchedTaxiSegment {
  startLat: number
  startLon: number
  endLat: number
  endLon: number
  name: string | null
  startHoldShort: boolean
  endHoldShort: boolean
}

export interface FetchedTaxiNetwork {
  icao: string
  segments: FetchedTaxiSegment[]
}

/** A large airport's `TAXI_POINT` list alone can take minutes to stream (EGLL: 5,389 points,
 *  ~170s, confirmed live 2026-09-28, winglog-backend's docs/navdata-notes.md) — this fetch
 *  needs a much longer timeout than `fetchAirportNavdata`'s 20s. 10 minutes covers the longest
 *  real session observed that night with headroom; a caller must treat this as a genuinely
 *  slow, explicit operation, never something fired silently in the background. */
const TAXI_FETCH_TIMEOUT_MS = 600_000

/** `TAXI_PATH.TYPE`'s numeric mapping is only partly confirmed (docs/navdata-notes.md,
 *  2026-09-28: `2` = Runway, confirmed; `1`/`4` are both plausible "Taxi"/"Path" drivable-
 *  network values, unconfirmed which is which) — both are fetched via separate filtered
 *  definitions and merged, rather than guessing one. */
const TAXI_PATH_TYPES = [1, 4] as const

function buildTaxiDefinitions(handle: SimConnectConnection): void {
  addAirportIcaoLatLonFields((name) => handle.addToFacilityDefinition(NavdataDefId.TAXI_POINTS, name))
  handle.addToFacilityDefinition(NavdataDefId.TAXI_POINTS, 'N_TAXI_POINTS')
  handle.addToFacilityDefinition(NavdataDefId.TAXI_POINTS, 'OPEN TAXI_POINT')
  addTaxiPointFields((name) => handle.addToFacilityDefinition(NavdataDefId.TAXI_POINTS, name))
  handle.addToFacilityDefinition(NavdataDefId.TAXI_POINTS, 'CLOSE TAXI_POINT')
  handle.addToFacilityDefinition(NavdataDefId.TAXI_POINTS, 'CLOSE AIRPORT')

  const pathDefIds = [NavdataDefId.TAXI_PATHS_TYPE_1, NavdataDefId.TAXI_PATHS_TYPE_4] as const
  for (const [i, defId] of pathDefIds.entries()) {
    addAirportIcaoLatLonFields((name) => handle.addToFacilityDefinition(defId, name))
    handle.addToFacilityDefinition(defId, 'N_TAXI_PATHS')
    handle.addToFacilityDefinition(defId, 'OPEN TAXI_PATH')
    addTaxiPathFields((name) => handle.addToFacilityDefinition(defId, name))
    handle.addToFacilityDefinition(defId, 'CLOSE TAXI_PATH')
    handle.addToFacilityDefinition(defId, 'CLOSE AIRPORT')
    const filterValue = new RawBuffer(4)
    filterValue.writeInt32(TAXI_PATH_TYPES[i]!)
    handle.addFacilityDataDefinitionFilter(defId, 'AIRPORT:TAXI_PATH:TYPE', filterValue)
  }

  addAirportIcaoLatLonFields((name) => handle.addToFacilityDefinition(NavdataDefId.TAXI_NAMES, name))
  handle.addToFacilityDefinition(NavdataDefId.TAXI_NAMES, 'N_TAXI_NAMES')
  handle.addToFacilityDefinition(NavdataDefId.TAXI_NAMES, 'OPEN TAXI_NAME')
  addTaxiNameFields((name) => handle.addToFacilityDefinition(NavdataDefId.TAXI_NAMES, name))
  handle.addToFacilityDefinition(NavdataDefId.TAXI_NAMES, 'CLOSE TAXI_NAME')
  handle.addToFacilityDefinition(NavdataDefId.TAXI_NAMES, 'CLOSE AIRPORT')
}

/** Fetches an airport's full taxiway network (points, filtered paths, names) on an
 *  already-open connection — see `fetchAirportNavdata`'s own doc comment for why this never
 *  opens its own connection. Unlike that fetch, this one can genuinely take minutes for a
 *  large airport (see `TAXI_FETCH_TIMEOUT_MS`); callers must treat it as an explicit,
 *  user-triggered operation, never an automatic background refresh.
 *
 * @param handle An open SimConnect connection the caller owns.
 * @param icao The airport.
 * @returns The taxi points, paths and names.
 * @throws When the sim reports an exception or the fetch times out.
 */
export function fetchTaxiNetwork(handle: SimConnectConnection, icao: string): Promise<FetchedTaxiNetwork> {
  buildTaxiDefinitions(handle)

  return new Promise((resolve, reject) => {
    let referenceLatitude: number | null = null
    let referenceLongitude: number | null = null
    const points = new Map<number, { holdShort: boolean; biasX: number; biasZ: number }>()
    const rawPaths: { start: number; end: number; nameIndex: number | null }[] = []
    const names = new Map<number, string>()
    const pending = new Set<NavdataDefId>([
      NavdataDefId.TAXI_POINTS,
      NavdataDefId.TAXI_PATHS_TYPE_1,
      NavdataDefId.TAXI_PATHS_TYPE_4,
      NavdataDefId.TAXI_NAMES
    ])
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timeoutTimer)
      handle.removeListener('facilityData', onFacilityData)
      handle.removeListener('facilityDataEnd', onFacilityDataEnd)
      handle.removeListener('facilityMinimalList', onFacilityMinimalList)
      handle.removeListener('exception', onException)
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      cleanup()
      if (referenceLatitude === null || referenceLongitude === null) {
        resolve({ icao, segments: [] })
        return
      }
      const refLat = referenceLatitude
      const refLon = referenceLongitude
      const segments: FetchedTaxiSegment[] = []
      for (const path of rawPaths) {
        const startPoint = points.get(path.start)
        const endPoint = points.get(path.end)
        if (!startPoint || !endPoint) continue
        const start = biasToLatLon(refLat, refLon, startPoint.biasX, startPoint.biasZ)
        const end = biasToLatLon(refLat, refLon, endPoint.biasX, endPoint.biasZ)
        const name = path.nameIndex === null ? null : (names.get(path.nameIndex) ?? null)
        segments.push({
          startLat: start.latitude,
          startLon: start.longitude,
          endLat: end.latitude,
          endLon: end.longitude,
          name,
          startHoldShort: startPoint.holdShort,
          endHoldShort: endPoint.holdShort
        })
      }
      resolve({ icao, segments })
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    function onFacilityData(recv: RecvFacilityData): void {
      const d = recv.data
      switch (recv.type) {
        case FacilityDataType.AIRPORT: {
          const header = parseAirportHeaderWithLatLon(d)
          if (referenceLatitude === null) {
            referenceLatitude = header.latitude
            referenceLongitude = header.longitude
          }
          break
        }
        case FacilityDataType.TAXI_POINT: {
          points.set(recv.itemIndex, parseTaxiPoint(d))
          break
        }
        case FacilityDataType.TAXI_PATH: {
          const parsed = parseTaxiPath(d)
          rawPaths.push({ start: parsed.start, end: parsed.end, nameIndex: parsed.nameIndex })
          break
        }
        case FacilityDataType.TAXI_NAME: {
          names.set(recv.itemIndex, parseTaxiName(d).name)
          break
        }
        default:
          break
      }
    }

    function onFacilityDataEnd(recv: RecvFacilityDataEnd): void {
      pending.delete(recv.userRequestId as NavdataDefId)
      if (pending.size === 0) finish()
    }

    function onFacilityMinimalList(recv: RecvFacilityMinimalList): void {
      // Same ambiguous-ICAO recovery as fetchAirportNavdata's own handler — see its comment.
      const defId = recv.requestID as NavdataDefId
      const region = recv.data[0]?.icao.region
      if (!pending.has(defId) || !region) return
      handle.requestFacilityData(defId, defId, icao, region)
    }

    function onException(recv: RecvException): void {
      fail(new Error(`SimConnect exception fetching ${icao} taxi network: ${recv.exceptionName} (index ${recv.index})`))
    }

    handle.on('facilityData', onFacilityData)
    handle.on('facilityDataEnd', onFacilityDataEnd)
    handle.on('facilityMinimalList', onFacilityMinimalList)
    handle.on('exception', onException)

    const timeoutTimer = setTimeout(() => fail(new Error(`Taxi network fetch for ${icao} timed out`)), TAXI_FETCH_TIMEOUT_MS)

    handle.requestFacilityData(NavdataDefId.TAXI_POINTS, NavdataDefId.TAXI_POINTS, icao)
    handle.requestFacilityData(NavdataDefId.TAXI_PATHS_TYPE_1, NavdataDefId.TAXI_PATHS_TYPE_1, icao)
    handle.requestFacilityData(NavdataDefId.TAXI_PATHS_TYPE_4, NavdataDefId.TAXI_PATHS_TYPE_4, icao)
    handle.requestFacilityData(NavdataDefId.TAXI_NAMES, NavdataDefId.TAXI_NAMES, icao)
  })
}

/** One stand/gate, positioned — see facility-fields.ts's ParsedTaxiParking. */
export interface FetchedStand {
  /** As ATC says it: "N32", "79". */
  name: string
  nameCode: number
  number: number
  suffix: number
  headingDeg: number
  lat: number
  lon: number
}

/** Stands come back in seconds even at VHHH (359 of them, live 2026-10-02) — unlike the
 *  taxi network, a fetch small enough to run on demand. */
const STAND_FETCH_TIMEOUT_MS = 60_000

/** Fetches an airport's stands/gates on an already-open connection. Its own definition, not
 *  part of fetchTaxiNetwork, so it never waits on (or invalidates) a minutes-long taxi fetch.
 *
 * @param handle An open SimConnect connection the caller owns.
 * @param icao The airport.
 * @returns The stands and gates.
 * @throws When the sim reports an exception or the fetch times out.
 */
export function fetchStands(handle: SimConnectConnection, icao: string): Promise<FetchedStand[]> {
  addAirportIcaoLatLonFields((name) => handle.addToFacilityDefinition(NavdataDefId.TAXI_PARKINGS, name))
  handle.addToFacilityDefinition(NavdataDefId.TAXI_PARKINGS, 'N_TAXI_PARKINGS')
  handle.addToFacilityDefinition(NavdataDefId.TAXI_PARKINGS, 'OPEN TAXI_PARKING')
  addTaxiParkingFields((name) => handle.addToFacilityDefinition(NavdataDefId.TAXI_PARKINGS, name))
  handle.addToFacilityDefinition(NavdataDefId.TAXI_PARKINGS, 'CLOSE TAXI_PARKING')
  handle.addToFacilityDefinition(NavdataDefId.TAXI_PARKINGS, 'CLOSE AIRPORT')

  return new Promise((resolve, reject) => {
    let reference: { lat: number; lon: number } | null = null
    const stands: FetchedStand[] = []
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timeoutTimer)
      handle.removeListener('facilityData', onFacilityData)
      handle.removeListener('facilityDataEnd', onFacilityDataEnd)
      handle.removeListener('facilityMinimalList', onFacilityMinimalList)
      handle.removeListener('exception', onException)
    }
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    function onFacilityData(recv: RecvFacilityData): void {
      if (recv.userRequestId !== NavdataDefId.TAXI_PARKINGS) return
      if (recv.type === FacilityDataType.AIRPORT) {
        const header = parseAirportHeaderWithLatLon(recv.data)
        reference ??= { lat: header.latitude, lon: header.longitude }
        return
      }
      if (recv.type !== FacilityDataType.TAXI_PARKING || !reference) return
      const p = parseTaxiParking(recv.data)
      const position = biasToLatLon(reference.lat, reference.lon, p.biasX, p.biasZ)
      stands.push({
        name: standLabel(p.nameCode, p.number),
        nameCode: p.nameCode,
        number: p.number,
        suffix: p.suffix,
        headingDeg: p.headingDeg,
        lat: position.latitude,
        lon: position.longitude
      })
    }
    function onFacilityDataEnd(recv: RecvFacilityDataEnd): void {
      if (recv.userRequestId === NavdataDefId.TAXI_PARKINGS) settle(() => resolve(stands))
    }
    function onFacilityMinimalList(recv: RecvFacilityMinimalList): void {
      // Same ambiguous-ICAO recovery as fetchAirportNavdata's own handler.
      const region = recv.data[0]?.icao.region
      if (recv.requestID !== NavdataDefId.TAXI_PARKINGS || !region) return
      handle.requestFacilityData(NavdataDefId.TAXI_PARKINGS, NavdataDefId.TAXI_PARKINGS, icao, region)
    }
    function onException(recv: RecvException): void {
      settle(() => reject(new Error(`SimConnect exception fetching ${icao} stands: ${recv.exceptionName} (index ${recv.index})`)))
    }

    handle.on('facilityData', onFacilityData)
    handle.on('facilityDataEnd', onFacilityDataEnd)
    handle.on('facilityMinimalList', onFacilityMinimalList)
    handle.on('exception', onException)
    const timeoutTimer = setTimeout(() => settle(() => reject(new Error(`Stand fetch for ${icao} timed out`))), STAND_FETCH_TIMEOUT_MS)

    handle.requestFacilityData(NavdataDefId.TAXI_PARKINGS, NavdataDefId.TAXI_PARKINGS, icao)
  })
}
