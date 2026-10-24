/**
 * Fetches the navdata a flight needs from the sim, in the main process, so no screen has to be open for it to happen: the runways and
 * procedures and the taxi network of the departure, arrival and alternate of the flight shown (the planned or tracked one). Before this,
 * whichever screen happened to be on asked for them, and a phone that asked while the sim was down just saw an empty chart.
 *
 * It fetches once per airport per flight. A fetch that fails (the sim is down, or still loading) is not counted as done, so it is tried
 * again the next time the shown flight changes or the sim connects.
 */

import { describeError } from '../logging/describe-error'
import { logger } from '../logging/logger'

/** The flight shown, as far as fetching goes. */
export interface ShownFlight {
  flightId: number
  depIcao: string
  arrIcao: string
  /** The plan, which names the alternate. */
  ofpJson: string | null
}

/** What the fetcher needs from the rest of the app. */
export interface FlightNavdataFetcherDeps {
  /** The sim's facility data; each call opens its own short-lived connection. */
  provider: {
    refreshAirport(icao: string): Promise<void>
    refreshTaxiNetwork(icao: string): Promise<void>
  }
  /** The planned or tracked flight, or undefined when there is none. */
  shownFlight(): ShownFlight | undefined
  /** Whether the sim is connected now. */
  simConnected(): boolean
  now(): number
}

type Kind = 'airport' | 'taxi'

const WHAT: Record<Kind, string> = { airport: 'runways and procedures', taxi: 'taxi network' }

/**
 * @param icao An airport code from a flight or its plan.
 * @returns Whether the sim can be asked about it: it isn't the "no airport" placeholder a free flight carries.
 */
function isRealIcao(icao: string | null | undefined): icao is string {
  return !!icao && icao !== 'ZZZZ'
}

/**
 * @param ofpJson The plan's JSON, if any.
 * @returns The alternate's code, or null when there is none or the plan can't be read.
 */
function alternateOf(ofpJson: string | null): string | null {
  if (!ofpJson) return null
  try {
    // The one field needed, read as `parseOfp` does (simbrief-ofp.ts); that parser wants every section of a full plan.
    const plan: unknown = JSON.parse(ofpJson)
    const alternate = (plan as { alternate?: { icao_code?: unknown } } | null)?.alternate
    const icao = alternate?.icao_code
    return typeof icao === 'string' && isRealIcao(icao) ? icao : null
  } catch {
    return null
  }
}

/**
 * @param flight The flight shown.
 * @returns Its arrival, departure and alternate, each once.
 */
function airportsOf(flight: ShownFlight): string[] {
  const codes = [flight.arrIcao, flight.depIcao, alternateOf(flight.ofpJson)]
  return [...new Set(codes.filter(isRealIcao))]
}

/** Fetches the shown flight's navdata from the sim, one fetch at a time. */
export class FlightNavdataFetcher {
  private readonly done = new Set<string>()
  /** Fetches waiting or running, so a trigger while one is queued doesn't queue it twice. */
  private readonly queued = new Set<string>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: FlightNavdataFetcherDeps) {}

  /**
   * Fetches whatever the shown flight is still missing. Call it whenever the shown flight may have changed and when the sim connects;
   * it does nothing when nothing is missing or the sim isn't connected.
   */
  refresh(): void {
    const flight = this.deps.shownFlight()
    if (!flight || !this.deps.simConnected()) return
    const airports = airportsOf(flight)
    // The arrival's runways and procedures first: the suggested approach waits on them.
    for (const kind of ['airport', 'taxi'] as const)
      for (const icao of airports) this.enqueue(flight.flightId, icao, kind)
  }

  /**
   * For tests.
   *
   * @returns Resolves when everything queued so far has been tried.
   */
  idle(): Promise<void> {
    return this.queue
  }

  private enqueue(flightId: number, icao: string, kind: Kind): void {
    const key = `${flightId}:${icao}:${kind}`
    if (this.done.has(key) || this.queued.has(key)) return
    this.queued.add(key)
    this.queue = this.queue.then(() => this.fetch(key, flightId, icao, kind))
  }

  /**
   * Runs one queued fetch, unless the flight has moved on or the sim has gone since it was queued.
   *
   * @param key The fetch's key in `done` and `queued`.
   * @param flightId The flight it was queued for.
   * @param icao The airport.
   * @param kind What to fetch.
   * @returns Resolves once it has been tried; never rejects.
   */
  private async fetch(key: string, flightId: number, icao: string, kind: Kind): Promise<void> {
    try {
      // The flight moved on, or the sim went away, while this waited its turn: nothing to fetch now.
      if (this.deps.shownFlight()?.flightId !== flightId || !this.deps.simConnected()) return
      const startedAt = this.deps.now()
      try {
        if (kind === 'airport') await this.deps.provider.refreshAirport(icao)
        else await this.deps.provider.refreshTaxiNetwork(icao)
      } catch (error) {
        logger.info(
          `[navdata] ${icao} ${WHAT[kind]} not fetched: ${describeError(error)} (tried again when the sim next connects)`
        )
        return
      }
      this.done.add(key)
      const seconds = ((this.deps.now() - startedAt) / 1000).toFixed(1)
      logger.info(`[navdata] ${icao} ${WHAT[kind]} fetched in ${seconds} s`)
    } finally {
      this.queued.delete(key)
    }
  }
}
