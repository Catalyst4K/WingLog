import {
  FacilityDataType,
  FacilityListType,
  open as defaultOpen,
  Protocol,
  type RecvAirportList,
  type RecvFacilityData,
  type SimConnectConnection
} from 'node-simconnect'
import { NavdataDefId, addRunwayFields, parseAirportHeader, parseRunway, type ParsedRunway } from '../sim/facility-fields'
import { runwayEndsFromCentre } from '../navdata/runway-geometry'
import { haversineNm } from './airport-search'
import { aimingPointDistanceForLengthM, resolveRunwayEnd, type RunwayEnd } from './runway-lookup'

/**
 * Resolves a touchdown to an airfield and runway using the *sim's own* facility data, for the
 * places the vendored OurAirports slice doesn't cover — scenery add-ons, closed historical
 * fields (Kai Tak = the sim's `VHHX`), generated strips (flightdeck-backend's
 * docs/plans/landing-airfield-from-sim.md; live spike 2026-09-19, docs/simconnect-notes.md:
 * the full ~85k-airport list arrives in ~0.3 s and a RUNWAYS request for one airport takes
 * ~30 ms).
 *
 * Like SimFacilitiesProvider it opens its own short-lived connection per call, never the
 * live tracking one.
 */

const APP_NAME = 'WingLog landing airfield'
const AIRPORT_LIST_REQUEST_ID = 1
/** Same reach as TrackingController's vendored search — a long runway's far end. */
const SEARCH_RADIUS_NM = 5
/** Airports are tried nearest-first; the sim lists many tiny generated strips around a real
 *  field, so a few candidates are needed, but not unbounded. */
const MAX_CANDIDATES = 10
const TIMEOUT_MS = 8_000

export interface SimAirfieldMatch {
  icao: string
  runway: RunwayEnd
}

export type OpenSimConnect = typeof defaultOpen

/** Adapts the sim's runway record (split into ends by runwayEndsFromCentre) to the vendored
 *  lookup's RunwayEnd shape. The sim gives no displaced-threshold figure here, so it's 0 —
 *  distances are from the physical end. */
export function simRunwayEnds(icao: string, runway: ParsedRunway): RunwayEnd[] {
  return runwayEndsFromCentre(runway).map((end) => ({
    icao: icao.toUpperCase(),
    ident: end.ident,
    lat: end.thresholdLat,
    lon: end.thresholdLon,
    headingTrueDeg: end.headingTrueDeg,
    lengthM: end.lengthM,
    widthM: end.widthM,
    displacedThresholdM: 0,
    elevationM: null,
    surface: null,
    aimingPointDistanceM: aimingPointDistanceForLengthM(end.lengthM)
  }))
}

function requestAirportList(handle: SimConnectConnection): Promise<{ icao: string; lat: number; lon: number }[]> {
  return new Promise((resolve) => {
    const airports: { icao: string; lat: number; lon: number }[] = []
    const onList = (list: RecvAirportList): void => {
      if (list.requestID !== AIRPORT_LIST_REQUEST_ID) return
      for (const a of list.airports) airports.push({ icao: a.icao, lat: a.latitude, lon: a.longitude })
      if (list.entryNumber + 1 >= list.outOf) {
        handle.removeListener('airportList', onList)
        resolve(airports)
      }
    }
    handle.on('airportList', onList)
    handle.requestFacilitiesList(FacilityListType.AIRPORT, AIRPORT_LIST_REQUEST_ID)
  })
}

function requestRunways(handle: SimConnectConnection, icao: string): Promise<ParsedRunway[]> {
  return new Promise((resolve) => {
    const runways: ParsedRunway[] = []
    const cleanup = (): void => {
      handle.removeListener('facilityData', onData)
      handle.removeListener('facilityDataEnd', onEnd)
      handle.removeListener('facilityMinimalList', onEnd)
      handle.removeListener('exception', onEnd)
    }
    const onData = (recv: RecvFacilityData): void => {
      if (recv.userRequestId !== NavdataDefId.RUNWAYS) return
      if (recv.type === FacilityDataType.RUNWAY) runways.push(parseRunway(recv.data))
      else if (recv.type === FacilityDataType.AIRPORT) parseAirportHeader(recv.data)
    }
    // Any terminal event — end of data, an ambiguous-ICAO candidate list, an exception —
    // just ends this candidate with whatever runways arrived (none, for the last two).
    const onEnd = (): void => {
      cleanup()
      resolve(runways)
    }
    handle.on('facilityData', onData)
    handle.on('facilityDataEnd', onEnd)
    handle.on('facilityMinimalList', onEnd)
    handle.on('exception', onEnd)
    handle.requestFacilityData(NavdataDefId.RUNWAYS, NavdataDefId.RUNWAYS, icao)
  })
}

export class SimAirfieldResolver {
  constructor(private readonly openSimConnect: OpenSimConnect = defaultOpen) {}

  /**
   * The airfield and runway end a touchdown at this position/heading was on, or null when the
   * sim isn't reachable, knows no airfield with a runway underneath the touchdown (an
   * off-airport landing), or takes too long. Never throws — the caller already holds a
   * perfectly good vendored-data landing record and this only ever improves it.
   */
  async resolve(lat: number, lon: number, headingTrueDeg: number): Promise<SimAirfieldMatch | null> {
    let handle: SimConnectConnection | undefined
    let timer: NodeJS.Timeout | undefined
    try {
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TIMEOUT_MS)
      })
      const work = (async (): Promise<SimAirfieldMatch | null> => {
        const opened = await this.openSimConnect(APP_NAME, Protocol.SunRise)
        handle = opened.handle
        handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, 'OPEN AIRPORT')
        handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, 'ICAO')
        addRunwayFields((name) => handle!.addToFacilityDefinition(NavdataDefId.RUNWAYS, name))
        handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, 'CLOSE AIRPORT')

        const candidates = (await requestAirportList(handle))
          .map((a) => ({ ...a, nm: haversineNm(lat, lon, a.lat, a.lon) }))
          .filter((a) => a.nm <= SEARCH_RADIUS_NM)
          .sort((a, b) => a.nm - b.nm)
          .slice(0, MAX_CANDIDATES)
        for (const candidate of candidates) {
          const ends = (await requestRunways(handle, candidate.icao)).flatMap((r) => simRunwayEnds(candidate.icao, r))
          const runway = resolveRunwayEnd(ends, candidate.icao, headingTrueDeg, lat, lon)
          if (runway) return { icao: candidate.icao.toUpperCase(), runway }
        }
        return null
      })()
      return await Promise.race([work, deadline])
    } catch {
      return null
    } finally {
      if (timer) clearTimeout(timer)
      try {
        handle?.close()
      } catch {
        // Already closed.
      }
    }
  }
}
