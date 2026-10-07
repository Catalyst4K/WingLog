/**
 * Parses SimToolkitPro's flight-log CSV export. Verified against a real export (same
 * rigor as the SimBrief OFP schema in M3, not assumed from documentation) — its columns
 * are: DepartureICAO, ArrivalICAO, AircraftReg, AirframeICAO, Callsign, FlightNo, Network,
 * DepDate (DD/MM/YY), DepTime (HHMM), ArrDate (DD/MM/YY), ArrTime (HHMM).
 * Callsign/Network aren't stored: WingLog's Flight has no matching field for either.
 */

import { t } from '../i18n'
import { columnIndex, parseCsvRows } from './csv'

export { parseCsvRows }

export interface StkpLogRow {
  depIcao: string
  arrIcao: string
  registration: string
  icaoType: string
  flightNumber: string | null
  actualOutUtc: string
  actualInUtc: string
}

/**
 * DD/MM/YYYY + HHMM, treated as UTC. The column header claims "(DD/MM/YY)" (two-digit
 * year) but a real export actually has four digits (e.g. "21/08/2026") — matches the
 * real data, not the header's label. UTC/Zulu block times are the standard aviation
 * logbook convention; the export has no explicit timezone marker either way.
 *
 * @param date DD/MM/YYYY.
 * @param time HHMM.
 * @returns An ISO time, or null when either doesn't match.
 */
export function parseStkpDateTime(date: string, time: string): string | null {
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date)
  const timeMatch = /^(\d{2})(\d{2})$/.exec(time)
  if (!dateMatch || !timeMatch) return null
  const [, dd, mm, yyyy] = dateMatch
  const [, hh, min] = timeMatch
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:00.000Z`
}

/**
 * One SimToolkitPro CSV row as a flight to import.
 *
 * @param header The CSV's header row.
 * @param row One data row.
 * @returns The flight, or why the row can't be imported.
 */
export function parseStkpRow(header: string[], row: string[]): { data: StkpLogRow } | { error: string } {
  const depIcao = row[columnIndex(header, 'DepartureICAO')]
  const arrIcao = row[columnIndex(header, 'ArrivalICAO')]
  const registration = row[columnIndex(header, 'AircraftReg')]
  const icaoType = row[columnIndex(header, 'AirframeICAO')]
  const flightNumber = row[columnIndex(header, 'FlightNo')] || null
  const actualOutUtc = parseStkpDateTime(
    row[columnIndex(header, 'DepDate (DD/MM/YY)')],
    row[columnIndex(header, 'DepTime (HHMM)')]
  )
  const actualInUtc = parseStkpDateTime(
    row[columnIndex(header, 'ArrDate (DD/MM/YY)')],
    row[columnIndex(header, 'ArrTime (HHMM)')]
  )

  if (!depIcao || !arrIcao || !registration || !icaoType || !actualOutUtc || !actualInUtc) {
    return { error: t('errors.missingOrMalformedField') }
  }
  return { data: { depIcao, arrIcao, registration, icaoType, flightNumber, actualOutUtc, actualInUtc } }
}
