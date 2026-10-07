/** Column definitions and comparators for the Logbook's flights and landings tables. */

import type { TFunction } from 'i18next'
import type { LogbookFlight, LandingListRow } from '@shared/ipc'

export type SortKey = 'date' | 'flight' | 'route' | 'aircraft' | 'block' | 'score' | 'fuel'

// 'score' is last (Callum, 2026-09-12) — it's the column most worth glancing down as a
// column, so it reads best at the row's end rather than interrupting block/fuel.
export const SORT_KEYS: SortKey[] = ['date', 'flight', 'route', 'aircraft', 'block', 'fuel', 'score']

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

export function compareFlights(
  a: LogbookFlight,
  b: LogbookFlight,
  key: SortKey,
  registrationFor: (flight: LogbookFlight) => string,
  scoreFor: (flightId: number) => number | null
): number {
  switch (key) {
    case 'date':
      return (a.actualOutUtc ?? '').localeCompare(b.actualOutUtc ?? '')
    case 'flight':
      return (a.flightNumber ?? '').localeCompare(b.flightNumber ?? '')
    case 'route':
      return `${a.depIcao}${a.arrIcao}`.localeCompare(`${b.depIcao}${b.arrIcao}`)
    case 'aircraft':
      return registrationFor(a).localeCompare(registrationFor(b))
    case 'block':
      return (a.blockMinutes ?? 0) - (b.blockMinutes ?? 0)
    // A missing score (no landing row — a CSV import, or a flight tracked before landing
    // capture shipped) sorts alongside a genuine 0, same convention 'block'/'fuel' above
    // already use for their own nullable fields.
    case 'score':
      return (scoreFor(a.id) ?? 0) - (scoreFor(b.id) ?? 0)
    case 'fuel':
      return (a.fuelBurnKg ?? 0) - (b.fuelBurnKg ?? 0)
  }
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

export function compareLandingRows(a: LandingListRow, b: LandingListRow, key: LandingSortKey): number {
  switch (key) {
    case 'date':
      return a.touchdownTsUtc.localeCompare(b.touchdownTsUtc)
    case 'aircraft':
      return a.aircraftRegistration.localeCompare(b.aircraftRegistration)
    case 'airport':
      return `${a.icao ?? ''}${a.runwayIdent ?? ''}`.localeCompare(`${b.icao ?? ''}${b.runwayIdent ?? ''}`)
    case 'flight':
      return (a.flightNumber ?? '').localeCompare(b.flightNumber ?? '')
    case 'rate':
      return a.verticalSpeedMs - b.verticalSpeedMs
    case 'gforce':
      return a.gForce - b.gForce
    // A missing score sorts alongside a genuine 0, same convention the flights table's own
    // score column already uses.
    case 'score':
      return (a.score ?? 0) - (b.score ?? 0)
  }
}
