/**
 * Navdata from the sim itself: SimFacilitiesProvider fetches an airport's runways, procedures, taxi
 * network and stands over a short-lived SimConnect connection of its own, caches them in the
 * database, and answers every lookup from that cache.
 */
import { open as defaultOpen, Protocol } from 'node-simconnect'
import { airacCycleStart, predatesCurrentCycle } from '@shared/airac'
import type { WingLogDb } from '../db/client'
import { logger } from '../logging/logger'
import {
  hasCachedAirport,
  hasCachedTaxiNetwork,
  listCachedProcedureLegs,
  listCachedProcedures,
  listCachedRunways,
  listCachedStands,
  listCachedTaxiSegments,
  navdataFetchTimes,
  replaceAirportNavdata,
  replaceAirportStands,
  replaceAirportTaxiSegments
} from '../db/navdata-repo'
import type {
  NavdataLeg,
  NavdataProcedureOption,
  NavdataProvider,
  NavdataRunway,
  NavdataTaxiSegment,
  ProcedureKind
} from './navdata-provider'
import type { NavdataStand } from '@shared/ipc'
import { fetchAirportNavdata, fetchStands, fetchTaxiNetwork } from './sim-facilities-fetch'

const APP_NAME = 'WingLog navdata'

/** After a background refresh fails (the sim isn't running), wait this long before trying that airport again. */
const REFRESH_RETRY_MS = 10 * 60 * 1000

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
  /** When each airport was last checked for a new AIRAC cycle, and when to try it again (Infinity once it is up to date). */
  private readonly cycleChecks = new Map<string, { cycleStartMs: number; retryAtMs: number }>()
  /** Background refreshes run one at a time, each on its own short-lived connection. */
  private background: Promise<void> = Promise.resolve()

  /**
   * @param db The database.
   * @param openSimConnect Opens a SimConnect connection; injected so tests don't need a live sim.
   * @param now The clock; injected so tests can step across an AIRAC cycle change.
   */
  constructor(
    private readonly db: WingLogDb,
    private readonly openSimConnect: OpenSimConnect = defaultOpen,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Navigation data changes on the AIRAC schedule (every 28 days), so cached data fetched before the current cycle began is out
   * of date, for Navigraph users above all, whose sim data moves on with each cycle. The first time an airport is used in a
   * cycle, any of its cached parts that predate the cycle are re-fetched in the background. What is cached keeps being served
   * meanwhile, and keeps being served if the sim isn't running: a failed attempt just tries again after REFRESH_RETRY_MS.
   *
   * @param icao The airport just used.
   */
  private refreshIfStale(icao: string): void {
    const at = this.now()
    const nowMs = at.getTime()
    const cycleStartMs = airacCycleStart(at).getTime()
    const seen = this.cycleChecks.get(icao)
    if (seen && seen.cycleStartMs === cycleStartMs && nowMs < seen.retryAtMs) return
    const times = navdataFetchTimes(this.db, icao)
    const stale = {
      airport: times.airport !== null && predatesCurrentCycle(times.airport, at),
      taxi: times.taxi !== null && predatesCurrentCycle(times.taxi, at),
      stands: times.stands !== null && predatesCurrentCycle(times.stands, at)
    }
    if (!stale.airport && !stale.taxi && !stale.stands) {
      this.cycleChecks.set(icao, { cycleStartMs, retryAtMs: Infinity })
      return
    }
    this.cycleChecks.set(icao, { cycleStartMs, retryAtMs: nowMs + REFRESH_RETRY_MS })
    this.background = this.background.then(async () => {
      try {
        if (stale.airport) await this.refreshAirport(icao)
        if (stale.taxi) await this.refreshTaxiNetwork(icao)
        if (stale.stands) await this.refreshStands(icao)
        this.cycleChecks.set(icao, { cycleStartMs, retryAtMs: Infinity })
        logger.info(`[navdata] ${icao} refreshed for the new AIRAC cycle`)
      } catch (error) {
        logger.info(`[navdata] ${icao} not refreshed for the new AIRAC cycle yet: ${String(error)}`)
      }
    })
  }

  async refreshAirport(icao: string): Promise<void> {
    const { handle } = await this.openSimConnect(APP_NAME, Protocol.SunRise)
    try {
      const fetched = await fetchAirportNavdata(handle, icao)
      replaceAirportNavdata(this.db, icao, fetched, this.now().toISOString())
    } finally {
      handle.close()
    }
  }

  hasAirport(icao: string): boolean {
    return hasCachedAirport(this.db, icao)
  }

  listRunways(icao: string): NavdataRunway[] {
    this.refreshIfStale(icao)
    return listCachedRunways(this.db, icao)
  }

  listSids(icao: string, runway: string | null = null): NavdataProcedureOption[] {
    this.refreshIfStale(icao)
    return listCachedProcedures(this.db, icao, 'sid', runway)
  }

  listStars(icao: string, runway: string | null = null): NavdataProcedureOption[] {
    this.refreshIfStale(icao)
    return listCachedProcedures(this.db, icao, 'star', runway)
  }

  listApproaches(icao: string, runway: string | null = null): NavdataProcedureOption[] {
    this.refreshIfStale(icao)
    return listCachedProcedures(this.db, icao, 'approach', runway)
  }

  getProcedureWaypoints(
    icao: string,
    kind: ProcedureKind,
    identifier: string,
    runway?: string | null,
    transition?: string | null
  ): NavdataLeg[] {
    return listCachedProcedureLegs(this.db, icao, kind, identifier, runway, transition)
  }

  async refreshTaxiNetwork(icao: string): Promise<void> {
    const { handle } = await this.openSimConnect(APP_NAME, Protocol.SunRise)
    try {
      const fetched = await fetchTaxiNetwork(handle, icao)
      replaceAirportTaxiSegments(this.db, icao, fetched, this.now().toISOString())
    } finally {
      handle.close()
    }
  }

  hasTaxiNetwork(icao: string): boolean {
    return hasCachedTaxiNetwork(this.db, icao)
  }

  getTaxiNetwork(icao: string): NavdataTaxiSegment[] {
    this.refreshIfStale(icao)
    return listCachedTaxiSegments(this.db, icao)
  }

  /** Airports already asked this session that turned out to have no stands — not re-asked
   *  until restart (an empty result isn't cached in the table). */
  private readonly noStands = new Set<string>()

  async getStands(icao: string): Promise<NavdataStand[]> {
    const cached = listCachedStands(this.db, icao)
    if (cached.length > 0) this.refreshIfStale(icao)
    if (cached.length > 0 || this.noStands.has(icao)) return cached
    try {
      await this.refreshStands(icao)
    } catch {
      return []
    }
    return listCachedStands(this.db, icao)
  }

  /**
   * Fetches an airport's stands from the sim and replaces the cached ones.
   *
   * @param icao The airport.
   */
  private async refreshStands(icao: string): Promise<void> {
    const { handle } = await this.openSimConnect(APP_NAME, Protocol.SunRise)
    try {
      const stands = await fetchStands(handle, icao)
      if (stands.length === 0) this.noStands.add(icao)
      replaceAirportStands(this.db, icao, stands, this.now().toISOString())
    } finally {
      handle.close()
    }
  }
}
