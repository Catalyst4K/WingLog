/**
 * electron-updater, configured for WingLog: it never downloads or installs on its own (the
 * pilot presses the buttons, update-install.ts decides when), takes only the published
 * non-prerelease release, and never goes backwards. The release's `latest.yml` carries each
 * installer's SHA-512, which electron-updater checks after the download.
 */

import { autoUpdater } from 'electron-updater'
import { logger } from '../logging/logger'
import type { UpdaterEngine } from './update-install'

/**
 * @returns The configured updater.
 */
export function createUpdaterEngine(): UpdaterEngine {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.logger = {
    info: (message) => logger.info(`[updater] ${String(message)}`),
    warn: (message) => logger.warn(`[updater] ${String(message)}`),
    error: (message) => logger.error(`[updater] ${String(message)}`)
  }
  return autoUpdater
}
