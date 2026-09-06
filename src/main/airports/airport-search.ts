// Local reference list for Dispatch's departure/destination airport search. Vendored
// data, not a live API: resources/airports.csv — a trimmed slice of OurAirports'
// airports.csv (public domain, see resources/airports.LICENSE.txt and
// docs/decisions.md), kept to rows with a 4-letter icao_code or gps_code and projected
// down to icao,name,municipality,iso_country,type. Unlike the two other vendored CSVs in
// this app, the real OurAirports source has quoted fields — parseCsvRows (db/csv.ts) is
// quote-aware for exactly this reason.
//
// Bundled via Vite's `?raw` import, same pattern as icao-types.ts.
import type { AirportOption } from '@shared/ipc'
import { columnIndex, parseCsvRows } from '../db/csv'
import airportsRaw from '../../../resources/airports.csv?raw'

export function loadAirports(raw: string): AirportOption[] {
  const [header, ...rows] = parseCsvRows(raw)
  const icaoIdx = columnIndex(header, 'icao')
  const nameIdx = columnIndex(header, 'name')
  const municipalityIdx = columnIndex(header, 'municipality')
  const isoCountryIdx = columnIndex(header, 'iso_country')

  return rows
    .filter((row) => row[icaoIdx] && row[nameIdx])
    .map((row) => ({
      icao: row[icaoIdx],
      name: row[nameIdx],
      municipality: row[municipalityIdx] || null,
      isoCountry: row[isoCountryIdx] ?? ''
    }))
}

const MAX_RESULTS = 20

/** Case-insensitive substring match over ICAO code, name, and municipality. */
export function searchAirportList(airports: AirportOption[], query: string): AirportOption[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []

  const results: AirportOption[] = []
  for (const a of airports) {
    if (
      a.icao.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      (a.municipality?.toLowerCase().includes(q) ?? false)
    ) {
      results.push(a)
      if (results.length >= MAX_RESULTS) break
    }
  }
  return results
}

// Parsed on first search, not at module load — ~43,400 rows is a real chunk of main-
// process heap (docs/decisions.md, memory-usage entry) that a session never touching
// Dispatch's airport search has no reason to pay for.
let allAirports: AirportOption[] | null = null

export function searchAirports(query: string): AirportOption[] {
  allAirports ??= loadAirports(airportsRaw)
  return searchAirportList(allAirports, query)
}
