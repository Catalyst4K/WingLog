// Local reference list for Dispatch's departure/destination airport search. Vendored
// data, not a live API: resources/airports.csv — a trimmed slice of OurAirports'
// airports.csv (public domain, see resources/airports.LICENSE.txt and
// docs/decisions.md), kept to rows with a 4-letter icao_code or gps_code and projected
// down to icao,name,municipality,iso_country,type,latitude_deg,longitude_deg. Unlike the
// two other vendored CSVs in this app, the real OurAirports source has quoted fields —
// parseCsvRows (db/csv.ts) is quote-aware for exactly this reason.
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

export function loadAirportCoords(raw: string): Map<string, { lat: number; lon: number }> {
  const [header, ...rows] = parseCsvRows(raw)
  const icaoIdx = columnIndex(header, 'icao')
  const latIdx = columnIndex(header, 'latitude_deg')
  const lonIdx = columnIndex(header, 'longitude_deg')

  const coords = new Map<string, { lat: number; lon: number }>()
  for (const row of rows) {
    const icao = row[icaoIdx]
    const latRaw = row[latIdx]
    const lonRaw = row[lonIdx]
    // Number('') is 0, not NaN — a blank field must be rejected before the conversion, or
    // a row with no coordinates on file silently becomes null island (0, 0).
    if (!icao || !latRaw || !lonRaw) continue
    const lat = Number(latRaw)
    const lon = Number(lonRaw)
    if (Number.isFinite(lat) && Number.isFinite(lon)) coords.set(icao, { lat, lon })
  }
  return coords
}

// Separate lazy cache from allAirports above — a session that only needs distance (or
// only search) shouldn't pay to parse the columns the other one uses.
let airportCoords: Map<string, { lat: number; lon: number }> | null = null

export function getAirportCoords(icao: string): { lat: number; lon: number } | null {
  airportCoords ??= loadAirportCoords(airportsRaw)
  return airportCoords.get(icao) ?? null
}

const EARTH_RADIUS_NM = 3440.065

/**
 * Great-circle (as-the-crow-flies) distance between two airports, in nautical miles —
 * used for Logbook's total-distance stat, not a routed distance. Null if either ICAO
 * isn't in the vendored list (an unlisted airstrip, or a typo'd/placeholder code from a
 * CSV import) — the caller treats that flight as contributing 0 rather than guessing.
 */
export function greatCircleDistanceNm(depIcao: string, arrIcao: string): number | null {
  const dep = getAirportCoords(depIcao)
  const arr = getAirportCoords(arrIcao)
  if (!dep || !arr) return null

  const lat1Rad = (dep.lat * Math.PI) / 180
  const lat2Rad = (arr.lat * Math.PI) / 180
  const dLat = ((arr.lat - dep.lat) * Math.PI) / 180
  const dLon = ((arr.lon - dep.lon) * Math.PI) / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a))
}

/**
 * Intermediate points along the great-circle path from `depIcao` to `arrIcao`, as
 * [lon, lat] pairs (GeoJSON order, matching route.ts's parseRouteFromOfpJson) — a fallback
 * planned-route line for Logbook flights with no OFP on file (docs/plans/
 * great-circle-fallback-route.md). Null under the same conditions as
 * greatCircleDistanceNm: either ICAO isn't in the vendored list.
 *
 * Spherical interpolation (slerp along the geodesic in 3D Cartesian space), not a naive
 * lerp between the two lat/lon pairs — MapLibre draws a line as straight segments in Web
 * Mercator between whatever points it's given, so a 2-point line wouldn't curve the way a
 * real great circle does on a long-haul route, and a plain lat/lon lerp also breaks across
 * the antimeridian. Working in Cartesian space sidesteps both.
 */
export function greatCircleWaypoints(
  depIcao: string,
  arrIcao: string,
  points = 100
): [number, number][] | null {
  const dep = getAirportCoords(depIcao)
  const arr = getAirportCoords(arrIcao)
  if (!dep || !arr) return null

  const lat1 = (dep.lat * Math.PI) / 180
  const lon1 = (dep.lon * Math.PI) / 180
  const lat2 = (arr.lat * Math.PI) / 180
  const lon2 = (arr.lon * Math.PI) / 180

  const angularDist =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
      )
    )

  // Same airport twice (or ~coincident) — a real if odd possibility from a CSV import.
  // The slerp weights below divide by sin(angularDist), which is ~0 here; a single-point
  // "line" is the sane degenerate case rather than propagating NaN.
  if (angularDist < 1e-10) return [[dep.lon, dep.lat]]

  const coords: [number, number][] = []
  for (let i = 0; i < points; i++) {
    const f = i / (points - 1)
    const a = Math.sin((1 - f) * angularDist) / Math.sin(angularDist)
    const b = Math.sin(f * angularDist) / Math.sin(angularDist)
    const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2)
    const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2)
    const z = a * Math.sin(lat1) + b * Math.sin(lat2)
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y))
    const lon = Math.atan2(y, x)
    coords.push([(lon * 180) / Math.PI, (lat * 180) / Math.PI])
  }
  return coords
}
