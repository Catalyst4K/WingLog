import type { Aircraft, DataFormat, Flight, Landing } from '@shared/ipc'
import { t } from '../i18n'
import { columnIndex, parseCsvRows, toCsv } from './csv'

/**
 * WingLog's own portable logbook format (flightdeck-backend docs/plans/data-export-import.md):
 * one record per completed flight, keyed by aircraft *registration* rather than an internal
 * id so a file moves between installs. It's a **summary**, not a backup — no OFP, no track
 * points (backup.ts is the whole-database path). Import restores the flights themselves;
 * the landing columns are export-only (a re-imported flight has no landing record).
 *
 * Units are explicit in the column names (`_kg`, `_fpm`, `_kt`) — the SI-internal rule stops
 * at the file boundary, and a spreadsheet user shouldn't have to guess.
 */
export interface LogbookRecord {
  registration: string
  icaoType: string
  flightNumber: string | null
  depIcao: string
  arrIcao: string
  outUtc: string
  inUtc: string
  blockMinutes: number | null
  airMinutes: number | null
  fuelOutKg: number | null
  fuelInKg: number | null
  fuelBurnKg: number | null
  landing: LogbookLandingSummary | null
}

export interface LogbookLandingSummary {
  touchdownFpm: number
  gForce: number
  crosswindKt: number | null
  runway: string | null
}

/** CSV column order — also the JSON key order for the flat fields. */
export const LOGBOOK_CSV_COLUMNS = [
  'registration',
  'aircraft_type',
  'flight_number',
  'dep_icao',
  'arr_icao',
  'out_utc',
  'in_utc',
  'block_minutes',
  'air_minutes',
  'fuel_out_kg',
  'fuel_in_kg',
  'fuel_burn_kg',
  'touchdown_fpm',
  'touchdown_g',
  'crosswind_kt',
  'landing_runway'
] as const

const FPM_PER_MS = 196.850394
const KT_PER_MS = 1.943844

const round = (value: number, places: number): number => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * One flight → one record, or null when it can't be exported usefully: not completed, no
 * block times (an import needs both), or no identifiable aircraft. A free flight tracked
 * with no fleet aircraft falls back to the sim's own registration/type.
 */
export function toLogbookRecord(f: Flight, aircraft: Aircraft | undefined, landing: Landing | undefined): LogbookRecord | null {
  if (f.status !== 'completed' || !f.actualOutUtc || !f.actualInUtc) return null
  const registration = aircraft?.registration ?? f.simRegistration
  const icaoType = aircraft?.icaoType ?? f.simIcaoType
  if (!registration || !icaoType) return null
  return {
    registration,
    icaoType,
    flightNumber: f.flightNumber,
    depIcao: f.depIcao,
    arrIcao: f.arrIcao,
    outUtc: f.actualOutUtc,
    inUtc: f.actualInUtc,
    blockMinutes: f.blockMinutes,
    airMinutes: f.airMinutes,
    fuelOutKg: f.fuelOutKg,
    fuelInKg: f.fuelInKg,
    fuelBurnKg: f.fuelBurnKg,
    landing: landing
      ? {
          touchdownFpm: Math.round(landing.verticalSpeedMs * FPM_PER_MS),
          gForce: round(landing.gForce, 2),
          crosswindKt: landing.crosswindMs === null ? null : round(landing.crosswindMs * KT_PER_MS, 1),
          runway: landing.runwayIdent
        }
      : null
  }
}

export function serializeLogbook(records: LogbookRecord[], format: DataFormat): string {
  if (format === 'json') return JSON.stringify(records, null, 2)
  return toCsv([
    [...LOGBOOK_CSV_COLUMNS],
    ...records.map((r) => [
      r.registration,
      r.icaoType,
      r.flightNumber,
      r.depIcao,
      r.arrIcao,
      r.outUtc,
      r.inUtc,
      r.blockMinutes,
      r.airMinutes,
      r.fuelOutKg,
      r.fuelInKg,
      r.fuelBurnKg,
      r.landing?.touchdownFpm ?? null,
      r.landing?.gForce ?? null,
      r.landing?.crosswindKt ?? null,
      r.landing?.runway ?? null
    ])
  ])
}

export type ParsedLogbookRow = { record: LogbookRecord; label: string } | { error: string; label: string }

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** Finite number, or null — accepts a JSON number or a CSV string, never NaN/Infinity. */
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

/** A UTC instant re-serialised to canonical ISO, or null if it isn't a real date. */
const isoInstant = (value: unknown): string | null => {
  const s = text(value)
  if (!s) return null
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

const icao = (value: unknown): string | null => {
  const s = text(value)?.toUpperCase() ?? null
  return s !== null && /^[A-Z0-9]{3,4}$/.test(s) ? s : null
}

/** Validates one untrusted object (a JSON element, or a CSV row keyed by header) — a bad
 *  field degrades to a skipped row with a reason, never a throw. */
function toRecord(raw: unknown, csv: boolean): ParsedLogbookRow {
  if (typeof raw !== 'object' || raw === null) {
    return { error: t('errors.expectedAnObject'), label: t('labels.unreadableRow') }
  }
  const o = raw as Record<string, unknown>
  const registration = text(o['registration'])
  const dep = icao(o[csv ? 'dep_icao' : 'depIcao'])
  const arr = icao(o[csv ? 'arr_icao' : 'arrIcao'])
  const label =
    [registration, dep && arr ? `${dep}-${arr}` : null].filter(Boolean).join(' ') || t('labels.unreadableRow')

  const icaoType = text(o[csv ? 'aircraft_type' : 'icaoType'])
  const outUtc = isoInstant(o[csv ? 'out_utc' : 'outUtc'])
  const inUtc = isoInstant(o[csv ? 'in_utc' : 'inUtc'])
  if (!registration || !icaoType || !dep || !arr || !outUtc || !inUtc) {
    return { error: t('errors.missingOrMalformedField'), label }
  }
  if (Date.parse(inUtc) < Date.parse(outUtc)) return { error: t('errors.inBlockBeforeOutBlock'), label }

  const landingRaw = csv ? null : (o['landing'] as Record<string, unknown> | null | undefined)
  const landingSource = csv ? o : landingRaw
  const touchdownFpm = landingSource ? num(landingSource[csv ? 'touchdown_fpm' : 'touchdownFpm']) : null
  const gForce = landingSource ? num(landingSource[csv ? 'touchdown_g' : 'gForce']) : null
  return {
    label,
    record: {
      registration,
      icaoType,
      flightNumber: text(o[csv ? 'flight_number' : 'flightNumber']),
      depIcao: dep,
      arrIcao: arr,
      outUtc,
      inUtc,
      blockMinutes: num(o[csv ? 'block_minutes' : 'blockMinutes']),
      airMinutes: num(o[csv ? 'air_minutes' : 'airMinutes']),
      fuelOutKg: num(o[csv ? 'fuel_out_kg' : 'fuelOutKg']),
      fuelInKg: num(o[csv ? 'fuel_in_kg' : 'fuelInKg']),
      fuelBurnKg: num(o[csv ? 'fuel_burn_kg' : 'fuelBurnKg']),
      landing:
        touchdownFpm !== null && gForce !== null && landingSource
          ? {
              touchdownFpm,
              gForce,
              crosswindKt: num(landingSource[csv ? 'crosswind_kt' : 'crosswindKt']),
              runway: text(landingSource[csv ? 'landing_runway' : 'runway'])
            }
          : null
    }
  }
}

/** True for a CSV whose header is one of *ours* (as opposed to SimToolkitPro's). */
export function isWingLogLogbookCsv(header: string[]): boolean {
  return columnIndex(header, 'registration') >= 0 && columnIndex(header, 'dep_icao') >= 0
}

/** Untrusted text → validated rows. Throws only when the text isn't a usable document at
 *  all (bad JSON, not an array, empty CSV); a bad *row* comes back as `{ error }`. */
export function parseLogbook(textInput: string, format: DataFormat): ParsedLogbookRow[] {
  if (format === 'json') {
    const parsed: unknown = JSON.parse(textInput)
    if (!Array.isArray(parsed)) throw new Error(t('errors.expectedJsonArrayOfFlights'))
    return parsed.map((row) => toRecord(row, false))
  }
  const [header, ...rows] = parseCsvRows(textInput)
  if (!header) throw new Error(t('errors.csvFileEmpty'))
  const names = header.map((h) => h.toLowerCase())
  return rows.map((row) => toRecord(Object.fromEntries(names.map((name, i) => [name, row[i] ?? ''])), true))
}
