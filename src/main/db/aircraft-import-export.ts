/**
 * Fleet import and export through a file dialog, as JSON or CSV. Each imported record goes through
 * the same validator as the renderer's own edits, and a registration already in the fleet is skipped,
 * not overwritten.
 */
import { writeFile } from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'
import type { AircraftImportSummary, DataFormat } from '@shared/ipc'
import { t } from '../i18n'
import { createAircraft, getAircraftByRegistration, listAircraft } from './aircraft-repo'
import { parseAircraftRecords, serializeAircraft, toAircraftExportRecord } from './aircraft-portable'
import { parseAircraftInput } from './aircraft-validation'
import type { WingLogDb } from './client'
import { readImportFile } from './import-limits'

/**
 * Writes the fleet to a file the pilot chooses.
 *
 * @param db The database.
 * @param window The window the save dialog opens over.
 * @param format JSON or CSV.
 * @returns True once written, false when the pilot cancelled.
 */
export async function exportAircraft(
  db: WingLogDb,
  window: BrowserWindow,
  format: DataFormat = 'json'
): Promise<boolean> {
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: t('dialogs.exportFleet'),
    defaultPath: `winglog-fleet.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  })
  if (canceled || !filePath) return false

  const records = listAircraft(db).map(toAircraftExportRecord)
  await writeFile(filePath, serializeAircraft(records, format), 'utf-8')
  return true
}

/**
 * Adds the aircraft in a file the pilot chooses.
 *
 * @param db The database.
 * @param window The window the open dialog opens over.
 * @param format JSON or CSV.
 * @returns How many were added and which were skipped, or null when the pilot cancelled.
 * @throws When the file is too large or isn't a readable document.
 */
export async function importAircraft(
  db: WingLogDb,
  window: BrowserWindow,
  format: DataFormat = 'json'
): Promise<AircraftImportSummary | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: t('dialogs.importFleet'),
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return null

  const path = filePaths[0]
  const records = parseAircraftRecords(await readImportFile(path, t('errors.fleetExportTooLarge')), format)

  const summary: AircraftImportSummary = { imported: 0, skipped: [] }
  for (const record of records) {
    const result = parseAircraftInput(record)
    const registration =
      typeof record === 'object' &&
      record !== null &&
      typeof (record as { registration?: unknown }).registration === 'string' &&
      (record as { registration: string }).registration.trim() !== ''
        ? (record as { registration: string }).registration
        : t('labels.unknownRegistration')

    if ('error' in result) {
      summary.skipped.push({ registration, reason: result.error })
      continue
    }
    if (getAircraftByRegistration(db, result.data.registration)) {
      summary.skipped.push({ registration: result.data.registration, reason: t('errors.registrationAlreadyExists') })
      continue
    }
    createAircraft(db, result.data)
    summary.imported++
  }
  return summary
}
