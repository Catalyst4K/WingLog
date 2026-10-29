/**
 * Which ATIS a weather tab shows: pure, so the choice is tested against the real feeds' shapes (winglog-backend docs/plans/online-atis-weather.md).
 *
 * VATSIM runs ATIS as stations of their own, and some airports split arrivals from departures with a middle part in the callsign
 * (`EGLL_D_ATIS`, `EGLL_A_ATIS`: 31 of 31 split callsigns in the 2026-10-24 capture). IVAO has no ATIS stations: each controller carries
 * its own, so the one shown is the first controller the pilot would call. The text is untrusted feed data and is only ever passed on as
 * text; the runway is the existing exactly-one-runway suggestion.
 */
import type {
  AirportAtis,
  AtisAnswer,
  AtisKind,
  AtisRequest,
  AtisSlot,
  OnlineNetwork,
  WeatherAtis
} from '@shared/ipc'
import { atisRunway } from './atis-runway'
import { airportPrefixes, prefixOf } from './airport-stations'
import type { ControllerPosition, FeedAtis, FeedSnapshot } from './feed-snapshot'

/** IVAO: the controllers whose ATIS is the airport's, in the order a departing pilot calls them. */
const DEPARTING_ORDER: ControllerPosition[] = ['del', 'gnd', 'twr', 'app']
/** IVAO: and in the order an arriving pilot does. A centre's or FSS's "ATIS" is a note about its sector, never an airport's. */
const ARRIVING_ORDER: ControllerPosition[] = ['app', 'twr', 'gnd', 'del']

/** VATSIM: the kinds a slot prefers, the first with any ATIS winning (so Dest names a departure ATIS as one when it is all there is). */
const PREFERRED_KINDS: Record<Exclude<AtisSlot, 'custom'>, AtisKind[]> = {
  departure: ['departure', 'single', 'arrival'],
  destination: ['arrival', 'single', 'departure'],
  alternate: ['arrival', 'single', 'departure']
}

/**
 * @param callsign A VATSIM ATIS station's callsign.
 * @returns Departure for `_D_`, arrival for `_A_`, else single.
 */
function vatsimKind(callsign: string): AtisKind {
  const middle = callsign.toUpperCase().split('_').slice(1, -1)
  if (middle.includes('D')) return 'departure'
  if (middle.includes('A')) return 'arrival'
  return 'single'
}

/**
 * @param atis A feed ATIS.
 * @param kind For whom it is.
 * @returns The ATIS as the panel shows it.
 */
function shown(atis: FeedAtis, kind: AtisKind): WeatherAtis {
  return { callsign: atis.callsign, code: atis.code, kind, lines: atis.lines, runway: atisRunway(atis.lines) }
}

/**
 * @param snapshot The feed.
 * @param icao The airport.
 * @param slot The weather tab asking.
 * @returns The ATIS to show, none when no ATIS is online there.
 */
export function atisForSlot(snapshot: FeedSnapshot, icao: string, slot: AtisSlot): WeatherAtis[] {
  const prefixes = airportPrefixes(icao)
  const here = snapshot.atis.filter((a) => prefixes.includes(prefixOf(a.callsign)))
  if (snapshot.network === 'vatsim') {
    const all = here.map((a) => shown(a, vatsimKind(a.callsign)))
    if (slot === 'custom') return all
    for (const kind of PREFERRED_KINDS[slot]) {
      const ofKind = all.filter((a) => a.kind === kind)
      if (ofKind.length > 0) return ofKind
    }
    return []
  }
  const order = slot === 'departure' ? DEPARTING_ORDER : ARRIVING_ORDER
  const byController = here.filter((a) => a.position !== null && order.includes(a.position))
  const ranked = [...byController].sort(
    (a, b) =>
      order.indexOf(a.position as ControllerPosition) - order.indexOf(b.position as ControllerPosition)
  )
  const chosen = slot === 'custom' ? ranked : ranked.slice(0, 1)
  return chosen.map((a) => shown(a, 'single'))
}

/**
 * Answers a list of requests from a feed.
 *
 * @param snapshot The latest feed, or null when it could not be read.
 * @param network The network chosen, or null for none (or IVAO without a VID): nothing is shown then.
 * @param requests The airports and tabs asked about.
 * @returns One answer per request, in order.
 */
export function answerAtis(
  snapshot: FeedSnapshot | null,
  network: OnlineNetwork | null,
  requests: AtisRequest[]
): AtisAnswer {
  if (network === null) return { network: null, airports: [] }
  const airports: AirportAtis[] = requests.map(({ icao, slot }) => {
    if (snapshot === null || snapshot.network !== network)
      return { icao, slot, state: 'unavailable', atis: [] }
    const atis = icao === 'ZZZZ' ? [] : atisForSlot(snapshot, icao, slot)
    return { icao, slot, state: atis.length > 0 ? 'shown' : 'none', atis }
  })
  return { network, airports }
}
