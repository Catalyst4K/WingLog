/**
 * Local reference list for the Fleet "Airline" search-by-name/ICAO field. Vendored data,
 * not a live API: resources/airlines.csv — a trimmed slice of the OpenFlights airline
 * database (ODbL-licensed source, see resources/airlines.LICENSE.txt and
 * docs/decisions.md). Verified real file: 5886 rows, columns name,icao,iata — no
 * quoted/embedded-comma fields except a handful of airline names, so parseCsvRows'
 * quote-aware parsing still applies (same as icao-types.ts/airport-search.ts).
 *
 * resources/airline-aliases.csv (same columns, hand-maintained, not from OpenFlights) adds
 * a handful of well-known rebrand/historical names that a frozen upstream dataset doesn't
 * have under that name — e.g. Cathay Dragon flew under that name for its last four years
 * but is only in OpenFlights as "Dragonair" (its pre-2016 name), so searching the actual
 * name people fly it under today found nothing. adsbdb.com's own /v0/airline endpoint was
 * considered as a replacement (docs/decisions.md) but only does exact ICAO/IATA lookup, no
 * name search, so it can't back this dropdown — it's used elsewhere, for resolving an
 * already-known code.
 *
 * Bundled via Vite's `?raw` import, same pattern as the other two vendored CSVs.
 */

import type { AirlineOption } from '@shared/ipc'
import { columnIndex, parseCsvRows } from '../db/csv'
import airlinesRaw from '../../../resources/airlines.csv?raw'
import airlineAliasesRaw from '../../../resources/airline-aliases.csv?raw'
import { lazy } from '@shared/lazy'

/**
 * @param raw An airlines CSV (name, icao, iata).
 * @returns Every row with a name and ICAO code.
 */
export function loadAirlines(raw: string): AirlineOption[] {
  const [header, ...rows] = parseCsvRows(raw)
  const nameIdx = columnIndex(header, 'name')
  const icaoIdx = columnIndex(header, 'icao')
  const iataIdx = columnIndex(header, 'iata')

  return rows
    .filter((row) => row[nameIdx] && row[icaoIdx])
    .map((row) => ({
      name: row[nameIdx],
      icao: row[icaoIdx],
      iata: row[iataIdx] || ''
    }))
}

const MAX_RESULTS = 20

/**
 * Case-insensitive substring match over airline name and ICAO code.
 *
 * @param airlines The airline list.
 * @param query What the user typed.
 * @returns Up to 20 matches; none for a query under two characters.
 */
export function searchAirlineList(airlines: AirlineOption[], query: string): AirlineOption[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []

  const results: AirlineOption[] = []
  for (const a of airlines) {
    if (a.name.toLowerCase().includes(q) || a.icao.toLowerCase().includes(q)) {
      results.push(a)
      if (results.length >= MAX_RESULTS) break
    }
  }
  return results
}

// Parsed on first use, not at module load (docs/decisions.md, memory-usage entry) — same
// reasoning as airport-search.ts. Shared by the exports below, since any of them can be the
// first to touch it (a Fleet airline search, a registration look-up, the operator ICAO backfill).
const getAllAirlines = lazy((): AirlineOption[] => [
  ...loadAirlines(airlinesRaw),
  ...loadAirlines(airlineAliasesRaw)
])

/**
 * Searches the vendored airlines and the hand-kept aliases.
 *
 * @param query What the user typed.
 * @returns Up to 20 matches from the vendored list and its aliases.
 */
export function searchAirlines(query: string): AirlineOption[] {
  return searchAirlineList(getAllAirlines(), query)
}

/**
 * Exact ICAO-code lookup — for resolving an airline adsbdb has already identified by its
 * real ICAO code (AircraftForm's registration "Look up"), as opposed to a human typing a
 * partial name into the Airline field. Routing a short exact code through the fuzzy
 * substring search above is unsafe: a 3-letter code like "SIA" substring-matches dozens of
 * unrelated names/codes ("Asiana", "Malaysia Airlines", ...), and MAX_RESULTS can truncate
 * before the real exact match is ever reached (docs/decisions.md, flight-test-findings
 * #1 — confirmed live: "SIA" has 65 substring matches, Singapore Airlines' own row is
 * #46, past the cap).
 *
 * @param icao The ICAO code.
 * @returns The airline, or undefined.
 */
export function findAirlineByIcao(icao: string): AirlineOption | undefined {
  const q = icao.trim().toLowerCase()
  if (!q) return undefined
  return getAllAirlines().find((a) => a.icao.toLowerCase() === q)
}

/** A real airline ICAO designator: three letters. The list also holds placeholders such as "???" and "===". */
const AIRLINE_ICAO = /^[A-Z]{3}$/

/**
 * Finds the airline an aircraft's stored operator is, to recover its ICAO code (what SimBrief's `airline` parameter and Dispatch's Airline ICAO
 * field want) when only the name and the IATA code were saved. It never guesses, and never turns a name alone into a code: the IATA code is
 * required. With a name saved too, only airlines with both that code and that name count, so a name that disagrees with the code ("ITA Airways"
 * with AZ, which the list has only as Alitalia) finds nothing. The candidates must share one ICAO, so "SQ" with no name (Singapore Airlines and
 * its cargo arm) finds nothing, and that ICAO must be three letters.
 *
 * @param airlines The airline list.
 * @param operator The operator's name as saved, or null.
 * @param iata The operator's IATA code as saved, or null.
 * @returns The airline, or undefined when there is none, more than one, or only a placeholder code.
 */
export function matchOperatorAirline(
  airlines: AirlineOption[],
  operator: string | null | undefined,
  iata: string | null | undefined
): AirlineOption | undefined {
  const name = (operator ?? '').trim().toLowerCase()
  const code = (iata ?? '').trim().toLowerCase()
  if (!code) return undefined
  const byCode = airlines.filter((a) => a.iata.toLowerCase() === code)
  const found = name ? byCode.filter((a) => a.name.toLowerCase() === name) : byCode
  const icaos = new Set(found.map((a) => a.icao))
  if (icaos.size !== 1 || !AIRLINE_ICAO.test(found[0].icao)) return undefined
  return found[0]
}

/**
 * Finds the airline a stored operator is in the vendored list and its aliases.
 *
 * @param operator The operator's name as saved, or null.
 * @param iata The operator's IATA code as saved, or null.
 * @returns The airline (see `matchOperatorAirline`), or undefined.
 */
export function findAirlineForOperator(
  operator: string | null | undefined,
  iata: string | null | undefined
): AirlineOption | undefined {
  return matchOperatorAirline(getAllAirlines(), operator, iata)
}
