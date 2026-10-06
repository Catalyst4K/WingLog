/**
 * Fleet IPC: the aircraft list, its import and export, and each aircraft's flights, landings and
 * last stand. Every channel is a query (coding-standards.md §9): plain IPC to the local database.
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { IpcChannels, type AircraftUpdate } from '@shared/ipc'
import { t } from '../i18n'
import type { WingLogDb } from '../db/client'
import { exportAircraft, importAircraft } from '../db/aircraft-import-export'
import {
  createAircraft,
  deleteAircraft,
  getAircraftById,
  listAircraft,
  replaceAircraft,
  retireAircraft,
  unretireAircraft,
  updateAircraft
} from '../db/aircraft-repo'
import { parseAircraftInput } from '../db/aircraft-validation'
import { listFlightsByAircraft, listLastParkedByAircraft } from '../db/flight-repo'
import { listLandingsByAircraft } from '../db/landing-repo'
import { resolveLandingScore } from '../db/landing-score-resolver'
import { asDataFormat } from './data-format'

/** What the fleet channels need. */
export interface FleetHandlerDeps {
  db: WingLogDb
  /** The window file dialogs open over. */
  window: BrowserWindow
  /** Pushes a change to the cloud copy, when signed in. */
  scheduleBackgroundSync: () => void
}

/**
 * Registers the fleet channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, the window and the background sync.
 */
export function registerFleetHandlers(ipcMain: IpcMain, { db, window, scheduleBackgroundSync }: FleetHandlerDeps): void {
  // Validated here, not just in the renderer — the renderer isn't a security boundary.
  const requireAircraftId = (id: unknown): number => {
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error(t('errors.invalidAircraftId'))
    return id
  }

  ipcMain.handle(IpcChannels.aircraftList, () => listAircraft(db))

  ipcMain.handle(IpcChannels.aircraftCreate, (_event, input: unknown) => {
    const result = parseAircraftInput(input)
    if ('error' in result) throw new Error(result.error)
    const created = createAircraft(db, result.data)
    scheduleBackgroundSync()
    return created
  })

  ipcMain.handle(IpcChannels.aircraftUpdate, (_event, input: AircraftUpdate) => {
    const { id, ...rest } = input
    const result = parseAircraftInput(rest)
    if ('error' in result) throw new Error(result.error)
    const updated = updateAircraft(db, { id, ...result.data })
    if (!updated) throw new Error(`Aircraft ${id} not found`)
    scheduleBackgroundSync()
    return updated
  })

  ipcMain.handle(IpcChannels.aircraftDelete, (_event, id: number) => {
    deleteAircraft(db, id)
    scheduleBackgroundSync()
  })

  ipcMain.handle(IpcChannels.aircraftReplace, (_event, retiredId: number, replacementId: number) => {
    replaceAircraft(db, { retiredId, replacementId })
    scheduleBackgroundSync()
  })

  ipcMain.handle(IpcChannels.aircraftRetire, (_event, id: unknown) => {
    retireAircraft(db, requireAircraftId(id))
    scheduleBackgroundSync()
  })

  ipcMain.handle(IpcChannels.aircraftUnretire, (_event, id: unknown) => {
    unretireAircraft(db, requireAircraftId(id))
    scheduleBackgroundSync()
  })

  ipcMain.handle(IpcChannels.aircraftImport, async (_event, format?: unknown) => {
    const summary = await importAircraft(db, window, asDataFormat(format))
    if (summary) scheduleBackgroundSync()
    return summary
  })

  ipcMain.handle(IpcChannels.aircraftExport, (_event, format?: unknown) =>
    exportAircraft(db, window, asDataFormat(format))
  )

  ipcMain.handle(IpcChannels.fleetListLandings, (_event, aircraftId: number) => {
    const icaoType = getAircraftById(db, aircraftId)?.icaoType ?? null
    return listLandingsByAircraft(db, aircraftId).map((row) => {
      const icao = row.icao ?? row.arrIcao
      return {
        ...row,
        ...resolveLandingScore(row, icao, icaoType)
      }
    })
  })

  ipcMain.handle(IpcChannels.fleetListFlights, (_event, aircraftId: number) =>
    listFlightsByAircraft(db, aircraftId)
  )

  ipcMain.handle(IpcChannels.fleetListLastParked, () => listLastParkedByAircraft(db))
}
