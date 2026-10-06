import { open as defaultOpen, Protocol } from 'node-simconnect'
import type { WingLogDb } from '../db/client'
import {
  hasCachedAirport,
  hasCachedTaxiNetwork,
  listCachedProcedureLegs,
  listCachedProcedures,
  listCachedRunways,
  listCachedStands,
  listCachedTaxiSegments,
  replaceAirportNavdata,
  replaceAirportStands,
  replaceAirportTaxiSegments
} from '../db/navdata-repo'
import type { NavdataLeg, NavdataProcedureOption, NavdataProvider, NavdataRunway, NavdataTaxiSegment, ProcedureKind } from './navdata-provider'
import type { NavdataStand } from '@shared/ipc'
import { fetchAirportNavdata, fetchStands, fetchTaxiNetwork } from './sim-facilities-fetch'

const APP_NAME = 'WingLog navdata'

/** Matches node-simconnect's `open` export — injected so tests don't need a live sim,
 *  same pattern as SimConnectService's OpenSimConnect. */
export type OpenSimConnect = typeof defaultOpen

/**
 * NavdataProvider backed by MSFS's own SimConnect Facilities API (Phase 3,
 * winglog-backend's docs/plans/navdata-without-navigraph.md). Every refreshAirport call
 * opens its own short-lived connection, fetches, and closes it — deliberately never shares
 * SimConnectService's live tracking connection, per the Phase 2 spike's isolation finding
 * (docs/navdata-notes.md: a heavy facility fetch stalled live telemetry for the full ~12.5s
 * the fetch took, when the two shared one connection).
 */
export class SimFacilitiesProvider implements NavdataProvider {
  constructor(
    private readonly db: WingLogDb,
    private readonly openSimConnect: OpenSimConnect = defaultOpen
  ) {}

  async refreshAirport(icao: string): Promise<void> {
    const { handle } = await this.openSimConnect(APP_NAME, Protocol.SunRise)
    try {
      const fetched = await fetchAirportNavdata(handle, icao)
      replaceAirportNavdata(this.db, icao, fetched, new Date().toISOString())
    } finally {
      handle.close()
    }
  }

  hasAirport(icao: string): boolean {
    return hasCachedAirport(this.db, icao)
  }

  listRunways(icao: string): NavdataRunway[] {
    return listCachedRunways(this.db, icao)
  }

  listSids(icao: string, runway: string | null = null): NavdataProcedureOption[] {
    return listCachedProcedures(this.db, icao, 'sid', runway)
  }

  listStars(icao: string, runway: string | null = null): NavdataProcedureOption[] {
    return listCachedProcedures(this.db, icao, 'star', runway)
  }

  listApproaches(icao: string, runway: string | null = null): NavdataProcedureOption[] {
    return listCachedProcedures(this.db, icao, 'approach', runway)
  }

  getProcedureWaypoints(icao: string, kind: ProcedureKind, identifier: string, runway?: string | null, transition?: string | null): NavdataLeg[] {
    return listCachedProcedureLegs(this.db, icao, kind, identifier, runway, transition)
  }

  async refreshTaxiNetwork(icao: string): Promise<void> {
    const { handle } = await this.openSimConnect(APP_NAME, Protocol.SunRise)
    try {
      const fetched = await fetchTaxiNetwork(handle, icao)
      replaceAirportTaxiSegments(this.db, icao, fetched, new Date().toISOString())
    } finally {
      handle.close()
    }
  }

  hasTaxiNetwork(icao: string): boolean {
    return hasCachedTaxiNetwork(this.db, icao)
  }

  getTaxiNetwork(icao: string): NavdataTaxiSegment[] {
    return listCachedTaxiSegments(this.db, icao)
  }

  /** Airports already asked this session that turned out to have no stands — not re-asked
   *  until restart (an empty result isn't cached in the table). */
  private readonly noStands = new Set<string>()

  async getStands(icao: string): Promise<NavdataStand[]> {
    const cached = listCachedStands(this.db, icao)
    if (cached.length > 0 || this.noStands.has(icao)) return cached
    try {
      const { handle } = await this.openSimConnect(APP_NAME, Protocol.SunRise)
      try {
        const stands = await fetchStands(handle, icao)
        if (stands.length === 0) this.noStands.add(icao)
        replaceAirportStands(this.db, icao, stands, new Date().toISOString())
      } finally {
        handle.close()
      }
    } catch {
      return []
    }
    return listCachedStands(this.db, icao)
  }
}
