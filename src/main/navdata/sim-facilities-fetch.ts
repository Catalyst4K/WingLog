/**
 * Reads an airport's navdata from MSFS through the SimConnect Facilities API: runways, procedures,
 * the taxi network and stands. Each fetch runs on a connection the caller opened and owns
 * (SimFacilitiesProvider), never on the live tracking connection.
 */
import {
  FacilityDataType,
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
  TaxiPathType,
  type ParsedRunway,
  type ParsedLeg,
  type ParsedTaxiParking,
  type ParsedTaxiPath
} from '../sim/facility-fields'
import { createRunwayCollector } from '../sim/runway-collector'

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
   * that this is where EGLL's STARs (zero transitions each) put every real
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
   * 424 shape confirmed live (docs/navdata-notes.md): a transition's own last
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
export function fetchAirportNavdata(
  handle: SimConnectConnection,
  icao: string
): Promise<FetchedAirportNavdata> {
  buildDefinitions(handle)
  return runFacilityFetch(handle, icao, {
    defIds: [NavdataDefId.RUNWAYS, NavdataDefId.DEPARTURES, NavdataDefId.ARRIVALS, NavdataDefId.APPROACHES],
    timeoutMs: FETCH_TIMEOUT_MS,
    what: 'navdata',
    timeoutMessage: `Facility fetch for ${icao} timed out`,
    ...airportNavdataCollector(icao)
  })
}

/** What one facility fetch requests, and how it collects the answer. */
interface FacilityFetch<T> {
  /** The definitions requested, each finished by its own facilityDataEnd. */
  defIds: readonly NavdataDefId[]
  /** How long to wait for all of them, in milliseconds. */
  timeoutMs: number
  /** Names what's fetched in an exception's message, e.g. "navdata". */
  what: string
  /** The timeout's message. */
  timeoutMessage: string
  /** Takes each record as it arrives. */
  onData: (recv: RecvFacilityData) => void
  /** What the fetch resolves with, once every definition has ended. */
  result: () => T
}

/** The part of a FacilityFetch that collects records. */
type FacilityCollector<T> = Pick<FacilityFetch<T>, 'onData' | 'result'>

/**
 * Runs one facility fetch on an open connection: listens, requests each definition, and settles
 * once all of them have ended, on a SimConnect exception, or at the timeout, whichever comes first,
 * then stops listening. An ambiguous ICAO (duplicate across regions) gets a minimal candidate list
 * instead of data; that definition is asked again once with the first candidate's region, the
 * recovery the Phase 2 spike used (unverified live: EGLL, VHHH and EGKK all resolved directly, but
 * it's the documented SDK contract).
 *
 * @param handle An open SimConnect connection the caller owns.
 * @param icao The airport.
 * @param fetch What to request and how to collect it.
 * @returns What the collector built.
 * @throws When the sim reports an exception or the fetch times out.
 */
function runFacilityFetch<T>(
  handle: SimConnectConnection,
  icao: string,
  fetch: FacilityFetch<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const pending = new Set<NavdataDefId>(fetch.defIds)
    let settled = false

    const settle = (done: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      handle.removeListener('facilityData', onFacilityData)
      handle.removeListener('facilityDataEnd', onFacilityDataEnd)
      handle.removeListener('facilityMinimalList', onFacilityMinimalList)
      handle.removeListener('exception', onException)
      done()
    }

    function onFacilityData(recv: RecvFacilityData): void {
      fetch.onData(recv)
    }

    function onFacilityDataEnd(recv: RecvFacilityDataEnd): void {
      pending.delete(recv.userRequestId as NavdataDefId)
      if (pending.size === 0) settle(() => resolve(fetch.result()))
    }

    function onFacilityMinimalList(recv: RecvFacilityMinimalList): void {
      const defId = recv.requestID as NavdataDefId
      const region = recv.data[0]?.icao.region
      if (!pending.has(defId) || !region) return
      handle.requestFacilityData(defId, defId, icao, region)
    }

    function onException(recv: RecvException): void {
      const message = `SimConnect exception fetching ${icao} ${fetch.what}: ${recv.exceptionName} (index ${recv.index})`
      settle(() => reject(new Error(message)))
    }

    handle.on('facilityData', onFacilityData)
    handle.on('facilityDataEnd', onFacilityDataEnd)
    handle.on('facilityMinimalList', onFacilityMinimalList)
    handle.on('exception', onException)

    const timeoutTimer = setTimeout(
      () => settle(() => reject(new Error(fetch.timeoutMessage))),
      fetch.timeoutMs
    )

    for (const defId of fetch.defIds) handle.requestFacilityData(defId, defId, icao)
  })
}

/**
 * A SID or STAR from its header record, before any of its transitions or legs arrive.
 *
 * @param header The DEPARTURE or ARRIVAL record.
 * @returns The procedure, with the counts its header promised.
 */
function emptyProcedure(header: ReturnType<typeof parseProcedureHeader>): FetchedProcedure {
  return {
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
}

/**
 * An approach from its header record, before any of its transitions or legs arrive.
 *
 * @param header The APPROACH record.
 * @returns The approach, with the counts its header promised.
 */
function emptyApproach(header: ReturnType<typeof parseApproachHeader>): FetchedApproach {
  return {
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
}

/**
 * Collects an airport's runways, SIDs, STARs and approaches, rebuilding each procedure's tree.
 *
 * A RUNWAY_TRANSITION/ENROUTE_TRANSITION/APPROACH_TRANSITION/APPROACH_LEG record only carries its
 * parent's uniqueRequestId (RecvFacilityData.parentUniqueRequestId), not which array it belongs in,
 * so these maps track that link. An APPROACH_LEG's parent is always one of its approach's
 * transitions (an approach registers no top-level APPROACH_LEG of its own, only
 * FINAL_APPROACH_LEG); a DEPARTURE/ARRIVAL's own APPROACH_LEG can be either a procedure directly
 * (a common leg) or one of its transitions, checked in that order since a transition is the more
 * specific match when both could apply.
 *
 * @param icao The airport.
 * @returns The collector.
 */
function airportNavdataCollector(icao: string): FacilityCollector<FetchedAirportNavdata> {
  const runwayCollector = createRunwayCollector()
  const navdata: FetchedAirportNavdata = {
    icao,
    runways: runwayCollector.runways,
    departures: [],
    arrivals: [],
    approaches: []
  }
  const procedureByUniqueRequestId = new Map<number, FetchedProcedure>()
  const transitionByUniqueRequestId = new Map<number, { legs: ParsedLeg[] }>()
  const approachByUniqueRequestId = new Map<number, FetchedApproach>()

  /**
   * Adds one facility record from the departures and arrivals request to the navdata being built: a
   * procedure, then its runway transitions, common legs and enroute transitions under it.
   *
   * @param recv The facility record from the sim.
   */
  const onProcedureRecord = (recv: RecvFacilityData): void => {
    const d = recv.data
    switch (recv.type) {
      case FacilityDataType.DEPARTURE:
      case FacilityDataType.ARRIVAL: {
        const procedure = emptyProcedure(parseProcedureHeader(d))
        ;(recv.userRequestId === NavdataDefId.DEPARTURES ? navdata.departures : navdata.arrivals).push(
          procedure
        )
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
        if (transitionParent) transitionParent.legs.push(leg)
        else procedureByUniqueRequestId.get(recv.parentUniqueRequestId)?.commonLegs.push(leg)
        break
      }
      default:
        break
    }
  }

  /**
   * Adds one facility record from the approaches request to the navdata being built: an approach, then
   * its transitions and legs under it.
   *
   * @param recv The facility record from the sim.
   */
  const onApproachRecord = (recv: RecvFacilityData): void => {
    const d = recv.data
    switch (recv.type) {
      case FacilityDataType.APPROACH: {
        const approach = emptyApproach(parseApproachHeader(d))
        navdata.approaches.push(approach)
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
        approachByUniqueRequestId.get(recv.parentUniqueRequestId)?.finalLegs.push(leg)
        break
      }
      default:
        break
    }
  }

  return {
    onData: (recv) => {
      if (recv.type === FacilityDataType.AIRPORT) {
        // Every definition here registers only ICAO at the airport level (no LATITUDE/LONGITUDE/
        // NAME anywhere), so this record's shape is uniform across all requests, sidestepping the
        // per-definition buffer-shape gotcha the Phase 2 spike found (docs/navdata-notes.md).
        parseAirportHeader(recv.data)
      } else if (recv.type === FacilityDataType.RUNWAY || recv.type === FacilityDataType.PAVEMENT) {
        runwayCollector.take(recv)
      } else {
        onProcedureRecord(recv)
        onApproachRecord(recv)
      }
    },
    result: () => navdata
  }
}

export interface FetchedTaxiSegment {
  startLat: number
  startLon: number
  endLat: number
  endLon: number
  name: string | null
  startHoldShort: boolean
  endHoldShort: boolean
  /** TAXI_PATH `TYPE` (`TaxiPathType`). */
  pathType: number
  widthM: number
  weight: number
  /** A runway path's runway; null on every other type. */
  runwayNumber: number | null
  runwayDesignator: number | null
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

export interface FetchedTaxiNetwork {
  icao: string
  segments: FetchedTaxiSegment[]
  stands: FetchedStand[]
}

/** The whole network comes back in 0.1 to 1.4 s, VHHH's 6,005 paths in 0.7 s, as one request (docs/navdata-notes.md, 2026-10-21; the
 *  minutes the 2026-09-27 entry saw were separate requests per child). */
const TAXI_FETCH_TIMEOUT_MS = 30_000

/** The path types kept: the drivable network (type 1 at some sceneries, 4 at others) and the runways, for later rule work. Parking,
 *  closed, vehicle and road paths are dropped (BeyondATC drives none of them). */
const KEPT_PATH_TYPES = new Set<number>([TaxiPathType.TAXI, TaxiPathType.RUNWAY, TaxiPathType.PATH])

/**
 * Registers the one facility definition that asks the sim for an airport's whole taxi network: points, paths, names and stands.
 *
 * @param handle The SimConnect connection.
 */
function buildTaxiDefinition(handle: SimConnectConnection): void {
  const add = (name: string): void => {
    handle.addToFacilityDefinition(NavdataDefId.TAXI_NETWORK, name)
  }
  addAirportIcaoLatLonFields(add)
  add('OPEN TAXI_POINT')
  addTaxiPointFields(add)
  add('CLOSE TAXI_POINT')
  add('OPEN TAXI_PATH')
  addTaxiPathFields(add)
  add('CLOSE TAXI_PATH')
  add('OPEN TAXI_NAME')
  addTaxiNameFields(add)
  add('CLOSE TAXI_NAME')
  add('OPEN TAXI_PARKING')
  addTaxiParkingFields(add)
  add('CLOSE TAXI_PARKING')
  add('CLOSE AIRPORT')
}

/**
 * Fetches an airport's whole taxi network, as the scenery installed now has it, in one request on an already-open connection (see
 * `fetchAirportNavdata` for why it never opens its own).
 *
 * @param handle An open SimConnect connection the caller owns.
 * @param icao The airport.
 * @returns The taxi segments and the stands.
 * @throws When the sim reports an exception or the fetch times out.
 */
export function fetchTaxiNetwork(handle: SimConnectConnection, icao: string): Promise<FetchedTaxiNetwork> {
  buildTaxiDefinition(handle)
  return runFacilityFetch(handle, icao, {
    defIds: [NavdataDefId.TAXI_NETWORK],
    timeoutMs: TAXI_FETCH_TIMEOUT_MS,
    what: 'taxi network',
    timeoutMessage: `Taxi network fetch for ${icao} timed out`,
    ...taxiNetworkCollector(icao)
  })
}

/** A taxi point as received: its offset from the airport reference point, in metres. */
interface RawTaxiPoint {
  holdShort: boolean
  biasX: number
  biasZ: number
}

/**
 * Collects an airport's taxi points, paths, names and stands, keyed by the index SimConnect gives each.
 *
 * @param icao The airport.
 * @returns The collector.
 */
function taxiNetworkCollector(icao: string): FacilityCollector<FetchedTaxiNetwork> {
  let reference: { lat: number; lon: number } | null = null
  const points = new Map<number, RawTaxiPoint>()
  const paths: ParsedTaxiPath[] = []
  const names = new Map<number, string>()
  const parkings: ParsedTaxiParking[] = []
  return {
    onData: (recv) => {
      const d = recv.data
      switch (recv.type) {
        case FacilityDataType.AIRPORT: {
          const header = parseAirportHeaderWithLatLon(d)
          reference ??= { lat: header.latitude, lon: header.longitude }
          break
        }
        case FacilityDataType.TAXI_POINT:
          points.set(recv.itemIndex, parseTaxiPoint(d))
          break
        case FacilityDataType.TAXI_PATH: {
          const parsed = parseTaxiPath(d)
          if (KEPT_PATH_TYPES.has(parsed.type)) paths.push(parsed)
          break
        }
        case FacilityDataType.TAXI_NAME:
          names.set(recv.itemIndex, parseTaxiName(d).name)
          break
        case FacilityDataType.TAXI_PARKING:
          parkings.push(parseTaxiParking(d))
          break
        default:
          break
      }
    },
    result: () => ({
      icao,
      segments: reference ? taxiSegments(reference, points, paths, names) : [],
      stands: reference ? positionedStands(reference, parkings) : []
    })
  }
}

/**
 * Turns the received paths into positioned, named segments, dropping any path whose start or end
 * point never arrived rather than emitting a broken segment.
 *
 * @param reference The airport reference point the biases are measured from.
 * @param points The taxi points, by index.
 * @param paths The taxi paths kept.
 * @param names The taxiway names, by index.
 * @returns The segments.
 */
function taxiSegments(
  reference: { lat: number; lon: number },
  points: Map<number, RawTaxiPoint>,
  paths: ParsedTaxiPath[],
  names: Map<number, string>
): FetchedTaxiSegment[] {
  const segments: FetchedTaxiSegment[] = []
  for (const path of paths) {
    const startPoint = points.get(path.start)
    const endPoint = points.get(path.end)
    if (!startPoint || !endPoint) continue
    const start = biasToLatLon(reference.lat, reference.lon, startPoint.biasX, startPoint.biasZ)
    const end = biasToLatLon(reference.lat, reference.lon, endPoint.biasX, endPoint.biasZ)
    segments.push({
      startLat: start.latitude,
      startLon: start.longitude,
      endLat: end.latitude,
      endLon: end.longitude,
      name: path.nameIndex === null ? null : (names.get(path.nameIndex) ?? null),
      startHoldShort: startPoint.holdShort,
      endHoldShort: endPoint.holdShort,
      pathType: path.type,
      widthM: path.widthM,
      weight: path.weight,
      runwayNumber: path.runwayNumber,
      runwayDesignator: path.runwayDesignator
    })
  }
  return segments
}

/**
 * Positions each stand from the airport reference point and names it the way ATC says it.
 *
 * @param reference The airport reference point the biases are measured from.
 * @param parkings The stands as received.
 * @returns The stands.
 */
function positionedStands(
  reference: { lat: number; lon: number },
  parkings: ParsedTaxiParking[]
): FetchedStand[] {
  return parkings.map((p) => {
    const position = biasToLatLon(reference.lat, reference.lon, p.biasX, p.biasZ)
    return {
      name: standLabel(p.nameCode, p.number),
      nameCode: p.nameCode,
      number: p.number,
      suffix: p.suffix,
      headingDeg: p.headingDeg,
      lat: position.latitude,
      lon: position.longitude
    }
  })
}
