/** Column definitions and comparators for the Logbook's flights and landings tables. */

import type { TFunction } from 'i18next'
import type { LogbookFlight, LandingListRow } from '@shared/ipc'

export type SortKey = 'date' | 'flight' | 'route' | 'aircraft' | 'block' | 'score' | 'fuel'

// 'score' is last — it's the column most worth glancing down as a
// column, so it reads best at the row's end rather than interrupting block/fuel.
export const SORT_KEYS: SortKey[] = ['date', 'flight', 'route', 'aircraft', 'block', 'fuel', 'score']

/**
 * The flights table's columns, in display order.
 *
 * @param t The translation function.
 * @returns Each column's sort key, label and any extra class.
 */
export function sortColumns(t: TFunction): { key: SortKey; label: string; className?: string }[] {
  return [
    { key: 'date', label: t('logbookView.sortColumns.date') },
    { key: 'flight', label: t('logbookView.sortColumns.flight') },
    { key: 'route', label: t('logbookView.sortColumns.route') },
    { key: 'aircraft', label: t('logbookView.sortColumns.aircraft') },
    { key: 'block', label: t('logbookView.sortColumns.block') },
    { key: 'fuel', label: t('logbookView.sortColumns.fuelBurn') },
    { key: 'score', label: t('logbookView.sortColumns.landingScore'), className: 'text-center' }
  ]
}

/** What the flight comparators need beyond the two rows: the aircraft's registration and the
 *  flight's landing score live outside LogbookFlight. */
interface FlightLookups {
  registrationFor: (flight: LogbookFlight) => string
  scoreFor: (flightId: number) => number | null
}

const FLIGHT_COMPARATORS: Record<SortKey, (a: LogbookFlight, b: LogbookFlight, l: FlightLookups) => number> =
  {
    date: (a, b) => (a.actualOutUtc ?? '').localeCompare(b.actualOutUtc ?? ''),
    flight: (a, b) => (a.flightNumber ?? '').localeCompare(b.flightNumber ?? ''),
    route: (a, b) => `${a.depIcao}${a.arrIcao}`.localeCompare(`${b.depIcao}${b.arrIcao}`),
    aircraft: (a, b, l) => l.registrationFor(a).localeCompare(l.registrationFor(b)),
    block: (a, b) => (a.blockMinutes ?? 0) - (b.blockMinutes ?? 0),
    // A missing score (no landing row — a CSV import, or a flight tracked before landing
    // capture shipped) sorts alongside a genuine 0, same convention 'block'/'fuel' here
    // already use for their own nullable fields.
    score: (a, b, l) => (l.scoreFor(a.id) ?? 0) - (l.scoreFor(b.id) ?? 0),
    fuel: (a, b) => (a.fuelBurnKg ?? 0) - (b.fuelBurnKg ?? 0)
  }

/**
 * Orders two logbook flights by one column.
 *
 * @param a The first flight.
 * @param b The second flight.
 * @param key The column.
 * @param registrationFor Gives a flight's aircraft registration.
 * @param scoreFor Gives a flight's landing score, or null when it has none.
 * @returns Negative, zero or positive, as for Array.sort.
 */
export function compareFlights(
  a: LogbookFlight,
  b: LogbookFlight,
  key: SortKey,
  registrationFor: (flight: LogbookFlight) => string,
  scoreFor: (flightId: number) => number | null
): number {
  return FLIGHT_COMPARATORS[key](a, b, { registrationFor, scoreFor })
}

export type LandingSortKey = 'date' | 'aircraft' | 'airport' | 'flight' | 'rate' | 'gforce' | 'score'

// Same column positions as the Flights table (Date, Flight, Route~Airport, Aircraft, ..., Score)
// so switching between the two tabs doesn't shuffle the headers around under the cursor.
export const LANDING_SORT_KEYS: LandingSortKey[] = [
  'date',
  'flight',
  'airport',
  'aircraft',
  'rate',
  'gforce',
  'score'
]

/**
 * The landings table's columns, in display order.
 *
 * @param t The translation function.
 * @returns Each column's sort key, label and any extra class.
 */
export function landingSortColumns(
  t: TFunction
): { key: LandingSortKey; label: string; className?: string }[] {
  return [
    { key: 'date', label: t('logbookView.landingSortColumns.date') },
    { key: 'flight', label: t('logbookView.landingSortColumns.flight') },
    { key: 'airport', label: t('logbookView.landingSortColumns.airport') },
    { key: 'aircraft', label: t('logbookView.landingSortColumns.aircraft') },
    { key: 'rate', label: t('logbookView.landingSortColumns.touchdownRate') },
    { key: 'gforce', label: t('logbookView.landingSortColumns.gForce') },
    { key: 'score', label: t('logbookView.landingSortColumns.score'), className: 'text-center' }
  ]
}

const LANDING_COMPARATORS: Record<LandingSortKey, (a: LandingListRow, b: LandingListRow) => number> = {
  date: (a, b) => a.touchdownTsUtc.localeCompare(b.touchdownTsUtc),
  aircraft: (a, b) => a.aircraftRegistration.localeCompare(b.aircraftRegistration),
  airport: (a, b) =>
    `${a.icao ?? ''}${a.runwayIdent ?? ''}`.localeCompare(`${b.icao ?? ''}${b.runwayIdent ?? ''}`),
  flight: (a, b) => (a.flightNumber ?? '').localeCompare(b.flightNumber ?? ''),
  rate: (a, b) => a.verticalSpeedMs - b.verticalSpeedMs,
  gforce: (a, b) => a.gForce - b.gForce,
  // A missing score sorts alongside a genuine 0, same convention the flights table's own
  // score column already uses.
  score: (a, b) => (a.score ?? 0) - (b.score ?? 0)
}

/**
 * Orders two landings by one column.
 *
 * @param a The first landing.
 * @param b The second landing.
 * @param key The column.
 * @returns Negative, zero or positive, as for Array.sort.
 */
export function compareLandingRows(a: LandingListRow, b: LandingListRow, key: LandingSortKey): number {
  return LANDING_COMPARATORS[key](a, b)
}
