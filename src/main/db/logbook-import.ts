import { writeFile } from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'
import type { DataFormat, LogbookImportSummary } from '@shared/ipc'
import { t } from '../i18n'
import { createAircraft, getAircraftByRegistration, listAircraft } from './aircraft-repo'
import type { WingLogDb } from './client'
import { createHistoricalFlight, listFlights } from './flight-repo'
import { readImportFile as readCappedFile } from './import-limits'
import { getLandingByFlight } from './landing-repo'
import { parseCsvRows, parseStkpRow } from './logbook-csv'
import { isWingLogLogbookCsv, parseLogbook, serializeLogbook, toLogbookRecord } from './logbook-portable'

/** One validated row ready to become a flight — the common shape both file formats
 *  (SimToolkitPro's CSV, WingLog's own CSV/JSON) reduce to. */
export interface ImportableFlight {
  depIcao: string
  arrIcao: string
  registration: string
  icaoType: string
  flightNumber: string | null
  actualOutUtc: string
  actualInUtc: string
  airMinutes?: number | null
  fuelOutKg?: number | null
  fuelInKg?: number | null
  fuelBurnKg?: number | null
}

export type ImportRow = { label: string; data: ImportableFlight } | { label: string; error: string }

/**
 * Creates a completed flight for every valid row, auto-creating fleet entries for
 * registrations WingLog hasn't seen, and skipping a row (with a reason) rather than
 * throwing when it's malformed or already present. Pure with respect to the file system —
 * the dialog wrappers below only read/parse, so re-importing an export is testable here.
 */
export function importFlightRows(db: WingLogDb, rows: ImportRow[]): LogbookImportSummary {
  // Loaded once and appended to locally rather than re-querying per row — this file is a
  // few hundred rows at most, and duplicate detection needs to see rows from earlier in
  // the same import too (re-running the same file shouldn't double up).
  const existing = listFlights(db)
  const summary: LogbookImportSummary = { imported: 0, aircraftCreated: 0, skipped: [] }

  for (const row of rows) {
    if ('error' in row) {
      summary.skipped.push({ label: row.label, reason: row.error })
      continue
    }
    const { depIcao, arrIcao, registration, icaoType, flightNumber, actualOutUtc, actualInUtc } = row.data
    const label = `${registration} ${depIcao}-${arrIcao}`

    // Most registrations in a personal logbook aren't "your fleet" in WingLog's sense
    // (aircraft you manage) — they're just whatever you flew. Auto-create a minimal fleet
    // entry so the import doesn't skip almost everything; flesh it out in Fleet later.
    let aircraft = getAircraftByRegistration(db, registration)
    if (!aircraft) {
      aircraft = createAircraft(db, { registration, icaoType })
      summary.aircraftCreated++
    }

    const isDuplicate = existing.some(
      (f) =>
        f.aircraftId === aircraft.id &&
        f.depIcao === depIcao &&
        f.arrIcao === arrIcao &&
        f.actualOutUtc === actualOutUtc
    )
    if (isDuplicate) {
      summary.skipped.push({ label, reason: t('errors.alreadyImported') })
      continue
    }

    const created = createHistoricalFlight(db, {
      aircraftId: aircraft.id,
      depIcao,
      arrIcao,
      flightNumber,
      actualOutUtc,
      actualInUtc,
      airMinutes: row.data.airMinutes,
      fuelOutKg: row.data.fuelOutKg,
      fuelInKg: row.data.fuelInKg,
      fuelBurnKg: row.data.fuelBurnKg
    })
    existing.push(created)
    summary.imported++
  }

  return summary
}

/** Reads a user-picked file, refusing anything implausibly large. The path always comes
 *  from a native dialog, never from the renderer. */
function readImportFile(path: string): Promise<string> {
  return readCappedFile(path, t('errors.logbookExportTooLarge'))
}

/** SimToolkitPro's CSV (the original importer) *or* WingLog's own CSV export, told apart
 *  by header — so one Import button handles both. */
export async function importLogbookCsv(db: WingLogDb, window: BrowserWindow): Promise<LogbookImportSummary | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: t('dialogs.importLogbookCsv'),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return null

  const raw = await readImportFile(filePaths[0])
  const [header, ...dataRows] = parseCsvRows(raw)
  if (header && isWingLogLogbookCsv(header)) {
    return importFlightRows(db, toImportRows(parseLogbook(raw, 'csv')))
  }

  return importFlightRows(
    db,
    dataRows.map((row): ImportRow => {
      const parsed = parseStkpRow(header, row)
      if ('error' in parsed) {
        return { label: row.slice(0, 3).join(' ') || t('labels.unreadableRow'), error: parsed.error }
      }
      return { label: `${parsed.data.registration} ${parsed.data.depIcao}-${parsed.data.arrIcao}`, data: parsed.data }
    })
  )
}

export async function importLogbookJson(db: WingLogDb, window: BrowserWindow): Promise<LogbookImportSummary | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: t('dialogs.importLogbookJson'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return null
  return importFlightRows(db, toImportRows(parseLogbook(await readImportFile(filePaths[0]), 'json')))
}

function toImportRows(parsed: ReturnType<typeof parseLogbook>): ImportRow[] {
  return parsed.map((row): ImportRow =>
    'error' in row
      ? { label: row.label, error: row.error }
      : {
          label: row.label,
          data: {
            depIcao: row.record.depIcao,
            arrIcao: row.record.arrIcao,
            registration: row.record.registration,
            icaoType: row.record.icaoType,
            flightNumber: row.record.flightNumber,
            actualOutUtc: row.record.outUtc,
            actualInUtc: row.record.inUtc,
            airMinutes: row.record.airMinutes,
            fuelOutKg: row.record.fuelOutKg,
            fuelInKg: row.record.fuelInKg,
            fuelBurnKg: row.record.fuelBurnKg
          }
        }
  )
}

/** Builds the export text for every exportable completed flight — pure aside from the DB reads. */
export function buildLogbookExport(db: WingLogDb, format: DataFormat): string {
  const aircraftById = new Map(listAircraft(db).map((a) => [a.id, a]))
  const records = listFlights(db).flatMap((f) => {
    const record = toLogbookRecord(f, f.aircraftId === null ? undefined : aircraftById.get(f.aircraftId), getLandingByFlight(db, f.id))
    return record ? [record] : []
  })
  return serializeLogbook(records, format)
}

export async function exportLogbook(db: WingLogDb, window: BrowserWindow, format: DataFormat): Promise<boolean> {
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: t('dialogs.exportLogbook'),
    defaultPath: `winglog-logbook.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  })
  if (canceled || !filePath) return false
  await writeFile(filePath, buildLogbookExport(db, format), 'utf-8')
  return true
}
