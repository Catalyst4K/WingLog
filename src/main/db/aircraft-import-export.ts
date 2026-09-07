import { readFile, writeFile } from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'
import type { Aircraft, AircraftImportSummary, NewAircraft } from '@shared/ipc'
import { createAircraft, getAircraftByRegistration, listAircraft } from './aircraft-repo'
import { parseAircraftInput } from './aircraft-validation'
import type { WingLogDb } from './client'

/** Export format matches NewAircraft exactly — id/createdAt are assigned on import, not carried over. */
function toExportRecord(a: Aircraft): NewAircraft {
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

export async function exportAircraft(db: WingLogDb, window: BrowserWindow): Promise<boolean> {
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: 'Export fleet',
    defaultPath: 'winglog-fleet.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (canceled || !filePath) return false

  const records = listAircraft(db).map(toExportRecord)
  await writeFile(filePath, JSON.stringify(records, null, 2), 'utf-8')
  return true
}

export async function importAircraft(
  db: WingLogDb,
  window: BrowserWindow
): Promise<AircraftImportSummary | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: 'Import fleet',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return null

  const raw = await readFile(filePaths[0], 'utf-8')
  const parsed: unknown = JSON.parse(raw)
  const records = Array.isArray(parsed) ? parsed : [parsed]

  const summary: AircraftImportSummary = { imported: 0, skipped: [] }
  for (const record of records) {
    const result = parseAircraftInput(record)
    const registration =
      typeof record === 'object' &&
      record !== null &&
      typeof (record as { registration?: unknown }).registration === 'string'
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
