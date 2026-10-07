/**
 * Local reference list for the Fleet "search aircraft type" fallback — used when a
 * registration lookup fails or the registration is fictional. Vendored data, not a live
 * API: resources/icao-aircraft-types.csv (ICAO Doc 8643, MIT-licensed source, see
 * resources/icao-aircraft-types.LICENSE.txt and docs/decisions.md). Verified real file:
 * 7389 rows, columns manufacturer,model,type_designator,description,engine_type,
 * engine_count,wtc — no quoted/embedded-comma fields.
 *
 * Bundled via Vite's `?raw` import (same mechanism M4 used for the maplibre worker URL)
 * rather than a runtime filesystem read, so it works identically in dev and packaged
 * builds with no extraResources/packaging path handling needed.
 */

import type { AircraftTypeOption } from '@shared/ipc'
import type { WakeCategory } from '@shared/landing-score'
import { columnIndex, parseCsvRows } from '../db/csv'
import icaoTypesRaw from '../../../resources/icao-aircraft-types.csv?raw'
import { lazy } from '@shared/lazy'

interface IcaoTypeRow {
  manufacturer: string
  model: string
  icaoType: string
  wakeCat: string
}

/**
 * @param raw The ICAO Doc 8643 CSV.
 * @returns Every row with a manufacturer, model and type designator.
 */
export function loadTypes(raw: string): IcaoTypeRow[] {
  const [header, ...rows] = parseCsvRows(raw)
  const manufacturerIdx = columnIndex(header, 'manufacturer')
  const modelIdx = columnIndex(header, 'model')
  const typeIdx = columnIndex(header, 'type_designator')
  const wtcIdx = columnIndex(header, 'wtc')

  return rows
    .filter((row) => row[manufacturerIdx] && row[modelIdx] && row[typeIdx])
    .map((row) => ({
      manufacturer: row[manufacturerIdx],
      model: row[modelIdx],
      icaoType: row[typeIdx],
      wakeCat: row[wtcIdx] ?? ''
    }))
}

const MAX_RESULTS = 20

/**
 * The source data hyphenates model numbers ("A-350-1000 XWB"), which a search for the
 * obvious "A350" (no hyphen) would otherwise miss entirely — verified against the real
 * vendored file, not a hypothetical. Stripped from both sides of the comparison.
 * Exported: aircraft-identity.ts reuses this exact rule to tell an exact model match from
 * a looser substring one when free flight's atcModel parsing hits the A320/A20N variant
 * ambiguity, rather than re-deriving the same normalization independently.
 *
 * @param s A model name or query.
 * @returns It lower case, without hyphens.
 */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/-/g, '')
}

/**
 * Case-insensitive, hyphen-insensitive substring match over manufacturer, model, and the ICAO type code.
 *
 * @param types The type list.
 * @param query What the user typed.
 * @returns Up to 20 matches; none for a query under two characters.
 */
export function searchTypes(types: IcaoTypeRow[], query: string): AircraftTypeOption[] {
  const q = normalize(query.trim())
  if (q.length < 2) return []

  const results: AircraftTypeOption[] = []
  for (const t of types) {
    if (
      normalize(t.manufacturer).includes(q) ||
      normalize(t.model).includes(q) ||
      normalize(t.icaoType).includes(q)
    ) {
      results.push(t)
      if (results.length >= MAX_RESULTS) break
    }
  }
  return results
}

// Parsed on first search, not at module load (docs/decisions.md, memory-usage entry) —
// same reasoning as airport-search.ts.
const allTypes = lazy(() => loadTypes(icaoTypesRaw))

/**
 * Searches the vendored ICAO type list.
 *
 * @param query What the user typed.
 * @returns Up to 20 matches from the vendored list.
 */
export function searchAircraftTypes(query: string): AircraftTypeOption[] {
  return searchTypes(allTypes(), query)
}

/**
 * @param value A `wtc` value, trimmed and upper case.
 * @returns True if it is a single wake category.
 */
function isWakeCategory(value: string): value is WakeCategory {
  return value === 'L' || value === 'M' || value === 'H' || value === 'J'
}

/** Exact type-code → real ICAO wake-turbulence-category lookup, for landing-score.ts's
 *  per-category baseline (docs/decisions.md, 2026-09-12) — as opposed to searchAircraftTypes'
 *  fuzzy manufacturer/model/code search above. Null for a type absent from the vendored
 *  data, or one whose real `wtc` value isn't a clean single category (e.g. "L/M", ~69 real
 *  rows) — not guessed at. When a type code appears with more than one wtc value across
 *  real rows, the first one loaded wins, same "don't overthink it" spirit as the rest of
 *  this vendored-CSV lookup. */
const wakeCategoryByType = lazy(() => buildWakeCategoryIndex(allTypes()))

/**
 * @param types The type list.
 * @returns Each type code's wake category, upper case keys.
 */
function buildWakeCategoryIndex(types: IcaoTypeRow[]): Map<string, WakeCategory> {
  const index = new Map<string, WakeCategory>()
  for (const t of types) {
    const upperType = t.icaoType.toUpperCase()
    if (index.has(upperType)) continue
    const wtc = t.wakeCat.trim().toUpperCase()
    if (isWakeCategory(wtc)) index.set(upperType, wtc)
  }
  return index
}

/**
 * The wake category for one type code (see wakeCategoryByType).
 *
 * @param icaoType The ICAO type designator.
 * @returns Its wake category, or null if unknown or mixed.
 */
export function getWakeCategory(icaoType: string): WakeCategory | null {
  return wakeCategoryByType().get(icaoType.toUpperCase()) ?? null
}
