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
  parseAirportHeader,
  parseRunway,
  parseProcedureHeader,
  parseRunwayTransition,
  parseEnrouteTransition,
  parseLeg,
  type ParsedRunway,
  type ParsedLeg
} from '../sim/facility-fields'

/**
 * Issues one runway + one departure + one arrival facility request for a single airport on
 * an already-open SimConnect connection, and resolves once all three complete. Deliberately
 * takes a connection rather than opening its own — see sim-facilities-provider.ts, which
 * owns a short-lived, dedicated connection per fetch so this never shares a wire with
 * SimConnectService's live tracking stream (flightdeck-backend's docs/navdata-notes.md:
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

export interface FetchedAirportNavdata {
  icao: string
  runways: ParsedRunway[]
  departures: FetchedProcedure[]
  arrivals: FetchedProcedure[]
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
}

export function fetchAirportNavdata(handle: SimConnectConnection, icao: string): Promise<FetchedAirportNavdata> {
  buildDefinitions(handle)

  return new Promise((resolve, reject) => {
    const runways: ParsedRunway[] = []
    const departures: FetchedProcedure[] = []
    const arrivals: FetchedProcedure[] = []
    // A RUNWAY_TRANSITION/ENROUTE_TRANSITION/APPROACH_LEG record only carries its parent's
    // uniqueRequestId (RecvFacilityData.parentUniqueRequestId), not which array it belongs
    // in — these two maps track that link. An APPROACH_LEG's parent is either a procedure
    // directly (a common leg) or one of its transitions (a transition-specific leg) —
    // checked in that order below since transitionByUniqueRequestId is the more specific
    // match when both could apply.
    const procedureByUniqueRequestId = new Map<number, FetchedProcedure>()
    const transitionByUniqueRequestId = new Map<number, FetchedRunwayTransition | FetchedEnrouteTransition>()
    const pending = new Set<NavdataDefId>([NavdataDefId.RUNWAYS, NavdataDefId.DEPARTURES, NavdataDefId.ARRIVALS])
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
      resolve({ icao, runways, departures, arrivals })
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
  })
}
