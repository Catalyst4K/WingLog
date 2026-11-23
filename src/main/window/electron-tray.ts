/**
 * The real tray icon, made with Electron's Tray and Menu (winglog-backend's docs/plans/tray.md). Kept apart
 * from TrayController so that class is tested without Electron; this file is the thin wiring around it.
 */

import { Menu, nativeImage, Tray } from 'electron'
import { t } from '../i18n'
import type { TrayActions, TrayHandle } from './TrayController'

/** The tray icon's edge in pixels; Windows scales it to the display's tray size. */
const TRAY_ICON_SIZE_PX = 32

/**
 * Creates the tray icon: a click opens WingLog, right-click offers Open and Quit.
 *
 * @param iconPath The icon picture's path.
 * @param actions What opening and quitting do.
 * @returns The icon, to retitle and remove.
 */
export function createElectronTray(iconPath: string, actions: TrayActions): TrayHandle {
  const tray = new Tray(trayImage(iconPath))
  tray.on('click', actions.onOpen)
  tray.on('double-click', actions.onOpen)
  // Built at the moment it is shown, so it is in the language chosen now.
  tray.on('right-click', () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: t('tray.open'), click: actions.onOpen },
        { type: 'separator' },
        { label: t('tray.quit'), click: actions.onQuit }
      ])
    )
  })
  return {
    setToolTip: (text) => tray.setToolTip(text),
    setIcon: (path) => tray.setImage(trayImage(path)),
    destroy: () => tray.destroy()
  }
}

/**
 * @param path The icon picture's path.
 * @returns The picture, at the tray's size.
 */
function trayImage(path: string): Electron.NativeImage {
  return nativeImage.createFromPath(path).resize({ width: TRAY_ICON_SIZE_PX })
}
