/**
 * The window's IPC: the renderer's answer to "Close WingLog?" (winglog-backend's docs/plans/tray.md). A command from the
 * renderer (coding-standards.md §9); the question itself is pushed to the renderer by CloseQuestion.
 */
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { CloseQuestion } from '../window/CloseQuestion'

/** What the window channels need. */
export interface WindowHandlerDeps {
  closeQuestion: Pick<CloseQuestion, 'answer'>
}

/**
 * Registers the window channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The close question to answer.
 */
export function registerWindowHandlers(ipcMain: IpcMain, { closeQuestion }: WindowHandlerDeps): void {
  // Anything but a plain true is "keep open", so a malformed message can never close the app.
  ipcMain.handle(IpcChannels.closeConfirmAnswer, (_event, close: unknown) =>
    closeQuestion.answer(close === true)
  )
}
