// Every airfield with a position, for the Track map's VFR overlay (flightdeck-backend
// docs/plans/map-language-and-declutter.md, Part C). Same vendored OurAirports slice as
// airport-search.ts (resources/airports.csv) — no new data source, nothing leaves the
// machine. Parsed on first use, not at module load: ~43,400 rows is a real chunk of heap
// (docs/decisions.md, memory-usage entry) that a session that never opens the overlay
// shouldn't pay for.
import type { Airfield, AirfieldType } from '@shared/ipc'
import { columnIndex, parseCsvRows } from '../db/csv'
import airportsRaw from '../../../resources/airports.csv?raw'

const AIRFIELD_TYPES: ReadonlySet<string> = new Set<AirfieldType>([
  'large_airport',
  'medium_airport',
  'small_airport',
  'heliport',
  'seaplane_base'
])

/** Pure — takes the CSV text so it's testable without the bundler's `?raw` import. Rows
 *  with no usable position, or of a type a pilot can't land on (balloonports), are dropped. */
export function loadAirfields(raw: string): Airfield[] {
  const [header, ...rows] = parseCsvRows(raw)
  const icaoIdx = columnIndex(header, 'icao')
  const nameIdx = columnIndex(header, 'name')
  const typeIdx = columnIndex(header, 'type')
  const latIdx = columnIndex(header, 'latitude_deg')
  const lonIdx = columnIndex(header, 'longitude_deg')

  const airfields: Airfield[] = []
  for (const row of rows) {
    const type = row[typeIdx]
    const lat = Number(row[latIdx])
    const lon = Number(row[lonIdx])
    if (!row[icaoIdx] || !AIRFIELD_TYPES.has(type)) continue
    if (row[latIdx] === '' || row[lonIdx] === '' || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
    airfields.push({
      icao: row[icaoIdx],
      name: row[nameIdx] ?? '',
      type: type as AirfieldType,
      latitude: lat,
      longitude: lon
    })
  }
  return airfields
}

let cache: Airfield[] | null = null

export function listAirfields(): Airfield[] {
  cache ??= loadAirfields(airportsRaw)
  return cache
}
