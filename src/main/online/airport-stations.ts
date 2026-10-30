/**
 * Which controllers and ATIS are online at an airport: pure, so the callsign matching is tested against real shapes.
 *
 * A controller's callsign is only a rough place name, so an airport is matched by the part before the first underscore (`EGLL_TWR`,
 * `DFW_E_TWR`, `HOU_46_CTR`). Many US stations use the three-letter code instead of the ICAO one (`JFK_TWR` for KJFK, 29 of 112 real
 * controllers in the 2026-10-24 capture), so a US airport (K, or P for Alaska and Hawaii) also matches its code without the first
 * letter. Observers are never in the snapshot's controllers. Enroute controllers have no position in either feed and are not listed.
 */
import type { OnlineAirportStations, OnlineStationPosition } from '@shared/ipc'
import type { FeedSnapshot } from './feed-snapshot'

/** The order stations are listed in, from the gate outwards. */
const POSITION_ORDER: OnlineStationPosition[] = ['del', 'gnd', 'twr', 'app', 'ctr', 'fss']

/**
 * @param icao An airport's ICAO code.
 * @returns The callsign prefixes that mean this airport: its ICAO code, and for a US airport the three-letter code too.
 */
export function airportPrefixes(icao: string): string[] {
  const code = icao.toUpperCase()
  const isUs = code.length === 4 && (code.startsWith('K') || code.startsWith('P'))
  return isUs ? [code, code.slice(1)] : [code]
}

/**
 * @param callsign A controller's or ATIS's callsign.
 * @returns The part before the first underscore, upper-case.
 */
export function prefixOf(callsign: string): string {
  return (callsign.split('_')[0] ?? '').toUpperCase()
}

/**
 * @param snapshot The parsed feed.
 * @param icaos The airports to look at. Duplicates and blanks are ignored, and so is ZZZZ: a free flight's airport that is not set, which
 *   no station can be at.
 * @returns For each airport, its controllers (del, gnd, twr, app, ctr, fss) and its ATIS.
 */
export function stationsAt(snapshot: FeedSnapshot, icaos: string[]): OnlineAirportStations[] {
  const unique = [
    ...new Set(
      icaos.map((icao) => icao.trim().toUpperCase()).filter((icao) => icao !== '' && icao !== 'ZZZZ')
    )
  ]
  return unique.map((icao) => {
    const prefixes = airportPrefixes(icao)
    const here = (callsign: string): boolean => prefixes.includes(prefixOf(callsign))
    return {
      icao,
      stations: snapshot.controllers
        .filter((c) => here(c.callsign))
        .sort((a, b) => POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position))
        .map((c) => ({ callsign: c.callsign, frequency: c.frequency, position: c.position })),
      // Only an ATIS station with a frequency of its own (VATSIM's): IVAO's ATIS is the controller's, already listed above.
      atis: snapshot.atis.flatMap((a) =>
        here(a.callsign) && a.frequency !== null
          ? [{ callsign: a.callsign, code: a.code, frequency: a.frequency }]
          : []
      )
    }
  })
}
