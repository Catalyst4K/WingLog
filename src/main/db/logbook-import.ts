import { readFile } from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'
import type { LogbookImportSummary } from '@shared/ipc'
import { createAircraft, getAircraftByRegistration } from './aircraft-repo'
import type { WingLogDb } from './client'
import { createHistoricalFlight, listFlights } from './flight-repo'
import { parseCsvRows, parseStkpRow } from './logbook-csv'

export async function importLogbookCsv(
  db: WingLogDb,
  window: BrowserWindow
): Promise<LogbookImportSummary | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: 'Import logbook CSV',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return null

  const raw = await readFile(filePaths[0], 'utf-8')
  const [header, ...dataRows] = parseCsvRows(raw)

  // Loaded once and appended to locally rather than re-querying per row — this file is a
  // few hundred rows at most, and duplicate detection needs to see rows from earlier in
  // the same import too (re-running the same CSV shouldn't double up).
  const existing = listFlights(db)
  const summary: LogbookImportSummary = { imported: 0, aircraftCreated: 0, skipped: [] }

  for (const row of dataRows) {
    const parsed = parseStkpRow(header, row)
    if ('error' in parsed) {
      summary.skipped.push({ label: row.slice(0, 3).join(' ') || '(unreadable row)', reason: parsed.error })
      continue
    }
    const { depIcao, arrIcao, registration, icaoType, flightNumber, actualOutUtc, actualInUtc } = parsed.data
    const label = `${registration} ${depIcao}-${arrIcao}`

    // Most registrations in a personal STKP logbook aren't "your fleet" in WingLog's
    // sense (aircraft you manage) — they're just whatever you flew. Auto-create a minimal
    // fleet entry so the import doesn't skip almost everything; flesh it out in Fleet later.
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
      summary.skipped.push({ label, reason: 'already imported' })
      continue
    }

    const created = createHistoricalFlight(db, {
      aircraftId: aircraft.id,
      depIcao,
      arrIcao,
      flightNumber,
      actualOutUtc,
      actualInUtc
    })
    existing.push(created)
    summary.imported++
  }

  return summary
}
