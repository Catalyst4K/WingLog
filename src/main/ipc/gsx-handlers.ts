/**
 * GSX ground-service invoice IPC (docs/decisions.md, gsx-invoices entry): choosing the receipts
 * folder, matching receipts to a flight, attaching an untagged one, and opening a receipt. Every
 * channel is a query (coding-standards.md §9) over GSX's receipt files and the local database.
 * Opt-in, off by default, and a no-op when disabled or unconfigured. Windows-only in practice
 * (GSX itself is Windows-only), but nothing here assumes that beyond defaultGsxReceiptsPath
 * returning null elsewhere.
 */
import { dialog, shell, type BrowserWindow, type IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { t } from '../i18n'
import type { WingLogDb } from '../db/client'
import { addInvoicesForFlight, isStoredReceiptPath, listInvoicesForFlight } from '../db/flight-invoice-repo'
import { buildFlightMatchWindow } from '../db/gsx-flight-window'
import { getGsxSettings } from '../db/settings-repo'
import { defaultGsxReceiptsPath } from '../gsx/default-path'
import { isInsideFolder } from '../files/is-inside-folder'
import { readReceipt, receiptFileFromPath, scanGsxFolder } from '../gsx/scan'

/** What the GSX invoice channels need. */
export interface GsxHandlerDeps {
  db: WingLogDb
  /** The window the folder dialog opens over. */
  window: BrowserWindow
  /** Pushes a change to the cloud copy, when signed in. */
  scheduleBackgroundSync: () => void
}

/**
 * Registers the GSX invoice channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, the window and the background sync.
 */
export function registerGsxHandlers(
  ipcMain: IpcMain,
  { db, window, scheduleBackgroundSync }: GsxHandlerDeps
): void {
  ipcMain.handle(IpcChannels.gsxBrowseFolder, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: t('dialogs.gsxReceiptsFolder'),
      defaultPath: defaultGsxReceiptsPath() ?? undefined,
      properties: ['openDirectory']
    })
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  })

  ipcMain.handle(IpcChannels.gsxRescanFlight, async (_event, flightId: number) => {
    const settings = getGsxSettings(db)
    if (!settings.enabled || !settings.folderPath)
      return { invoices: listInvoicesForFlight(db, flightId), notailCandidates: [] }
    const matchWindow = buildFlightMatchWindow(db, flightId)
    if (!matchWindow) return { invoices: listInvoicesForFlight(db, flightId), notailCandidates: [] }

    const result = await scanGsxFolder(settings.folderPath, matchWindow)
    const invoices = addInvoicesForFlight(db, flightId, result.matched)
    if (result.matched.length > 0) scheduleBackgroundSync()
    return {
      invoices,
      notailCandidates: result.notailCandidates.map((f) => ({
        serviceGroup: f.serviceGroup,
        jsonPath: f.jsonPath,
        issuedUtc: f.parsed.timestampUtc,
        icao: f.parsed.icao
      }))
    }
  })

  ipcMain.handle(IpcChannels.gsxAttachNotailReceipt, async (_event, flightId: number, jsonPath: unknown) => {
    // Only a receipt inside the GSX folder WingLog scans: the path comes from the renderer.
    const { folderPath } = getGsxSettings(db)
    if (typeof jsonPath !== 'string' || !folderPath || !isInsideFolder(folderPath, jsonPath)) {
      return listInvoicesForFlight(db, flightId)
    }
    const file = receiptFileFromPath(jsonPath)
    if (!file) return listInvoicesForFlight(db, flightId)
    const invoice = await readReceipt(file)
    if (!invoice) return listInvoicesForFlight(db, flightId)
    const invoices = addInvoicesForFlight(db, flightId, [invoice])
    scheduleBackgroundSync()
    return invoices
  })

  // Only a receipt WingLog stored: shell.openPath runs whatever it's given, so a path from the
  // renderer is never trusted on its own.
  ipcMain.handle(IpcChannels.gsxOpenReceipt, async (_event, sourceHtmlPath: unknown) => {
    if (typeof sourceHtmlPath !== 'string' || !isStoredReceiptPath(db, sourceHtmlPath)) return
    await shell.openPath(sourceHtmlPath)
  })
}
