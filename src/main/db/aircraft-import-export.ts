import { readFile, stat, writeFile } from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'
import type { AircraftImportSummary, DataFormat } from '@shared/ipc'
import { createAircraft, getAircraftByRegistration, listAircraft } from './aircraft-repo'
import { parseAircraftRecords, serializeAircraft, toAircraftExportRecord } from './aircraft-portable'
import { parseAircraftInput } from './aircraft-validation'
import type { WingLogDb } from './client'
import { MAX_IMPORT_BYTES } from './import-limits'

export async function exportAircraft(
  db: WingLogDb,
  window: BrowserWindow,
  format: DataFormat = 'json'
): Promise<boolean> {
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: 'Export fleet',
    defaultPath: `winglog-fleet.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  })
  if (canceled || !filePath) return false

  const records = listAircraft(db).map(toAircraftExportRecord)
  await writeFile(filePath, serializeAircraft(records, format), 'utf-8')
  return true
}

export async function importAircraft(
  db: WingLogDb,
  window: BrowserWindow,
  format: DataFormat = 'json'
): Promise<AircraftImportSummary | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: 'Import fleet',
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return null

  const path = filePaths[0]
  if ((await stat(path)).size > MAX_IMPORT_BYTES) throw new Error('That file is too large to be a fleet export')
  const records = parseAircraftRecords(await readFile(path, 'utf-8'), format)

  const summary: AircraftImportSummary = { imported: 0, skipped: [] }
  for (const record of records) {
    const result = parseAircraftInput(record)
    const registration =
      typeof record === 'object' &&
      record !== null &&
      typeof (record as { registration?: unknown }).registration === 'string' &&
      (record as { registration: string }).registration.trim() !== ''
        ? (record as { registration: string }).registration
        : '(unknown)'

    if ('error' in result) {
      summary.skipped.push({ registration, reason: result.error })
      continue
    }
    if (getAircraftByRegistration(db, result.data.registration)) {
      summary.skipped.push({ registration: result.data.registration, reason: 'registration already exists' })
      continue
    }
    createAircraft(db, result.data)
    summary.imported++
  }
  return summary
}
