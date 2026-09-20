import type { Aircraft, DataFormat, NewAircraft } from '@shared/ipc'
import { t } from '../i18n'
import { parseCsvRows, toCsv } from './csv'

/** The fields a fleet export carries — NewAircraft's identity subset. id/createdAt are
 *  assigned on import, not carried over. Order is the CSV column order. */
export const AIRCRAFT_EXPORT_COLUMNS = [
  'registration',
  'icaoType',
  'operator',
  'operatorIata',
  'operatorIcao',
  'simbriefAirframeId',
  'simbriefType',
  'currentIcao'
] as const

export function toAircraftExportRecord(a: Aircraft): NewAircraft {
  return {
    registration: a.registration,
    icaoType: a.icaoType,
    operator: a.operator,
    operatorIata: a.operatorIata,
    operatorIcao: a.operatorIcao,
    simbriefAirframeId: a.simbriefAirframeId,
    simbriefType: a.simbriefType,
    currentIcao: a.currentIcao
  }
}

/** Pure — no Electron, no filesystem — so the formats are unit-testable on their own. */
export function serializeAircraft(records: NewAircraft[], format: DataFormat): string {
  if (format === 'json') return JSON.stringify(records, null, 2)
  const header = [...AIRCRAFT_EXPORT_COLUMNS]
  return toCsv([header, ...records.map((r) => header.map((column) => r[column] ?? null))])
}

/**
 * Untrusted text → an array of raw records, each still to be validated by
 * `parseAircraftInput` (which owns the field rules, so both formats and the renderer's own
 * IPC share one validator). A CSV blank cell is passed through as '' — `parseAircraftInput`
 * turns that into a cleared (null) field, same as a JSON null. Throws on text that isn't a
 * usable document at all (bad JSON, a CSV with no header), never on a single bad row.
 */
export function parseAircraftRecords(text: string, format: DataFormat): unknown[] {
  if (format === 'json') {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  const [header, ...rows] = parseCsvRows(text)
  if (!header) throw new Error(t('errors.csvFileEmpty'))
  return rows.map((row) => {
    const record: Record<string, string> = {}
    header.forEach((name, i) => {
      const column = AIRCRAFT_EXPORT_COLUMNS.find((c) => c.toLowerCase() === name.toLowerCase())
      if (column) record[column] = row[i] ?? ''
    })
    return record
  })
}
