/**
 * Downloads and installs a release from inside WingLog (winglog-backend's
 * docs/plans/one-click-update.md). The update check (update-check.ts) stays the source of truth
 * for whether there is an update; this is only the download-and-install mechanism, wrapping
 * electron-updater behind a small interface so it can be tested without a real installer.
 *
 * Nothing installs by itself: the pilot presses "Restart to update", and never while a flight is
 * being tracked.
 */

import { EventEmitter } from 'node:events'
import type { UpdateInstallOutcome, UpdateInstallState } from '@shared/ipc'

/** The slice of electron-updater's `AppUpdater` this uses. */
export interface UpdaterEngine {
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
}

export interface UpdateInstallerOptions {
  /** Null on a build that can't install by itself (unpackaged, dev build, not Windows). */
  engine: UpdaterEngine | null
  isFlightActive: () => boolean
  log?: (message: string) => void
}

/**
 * Whether this build can install an update itself: an installed Windows build of a release. The
 * dev build would replace itself with the public release, and an unpackaged or non-Windows build
 * has no installer to run, so those keep "Download" opening the release page.
 *
 * @param build What kind of build is running.
 * @returns True if the in-app install is available.
 */
export function canInstallInApp(build: {
  isPackaged: boolean
  isDevBuild: boolean
  platform: string
}): boolean {
  return build.isPackaged && !build.isDevBuild && build.platform === 'win32'
}

const IDLE: UpdateInstallState = { supported: false, phase: 'idle', percent: 0 }

/**
 * Holds the download's progress and does the install.
 */
export class UpdateInstaller extends EventEmitter<{ state: [UpdateInstallState] }> {
  private state: UpdateInstallState
  private readonly log: (message: string) => void

  constructor(private readonly options: UpdateInstallerOptions) {
    super()
    this.log = options.log ?? (() => {})
    this.state = { ...IDLE, supported: options.engine !== null }
    options.engine?.on('download-progress', (progress) => {
      if (this.state.phase === 'downloading')
        this.setState({ ...this.state, percent: toPercent(progress.percent) })
    })
  }

  /**
   * @returns The current install state.
   */
  getState(): UpdateInstallState {
    return this.state
  }

  /**
   * Downloads `version` in the background. Does nothing if it is already downloading or ready.
   * The updater looks at the release itself; if it finds a different version from the one the
   * update check found, nothing is downloaded.
   *
   * @param version The version the update check found.
   */
  async download(version: string): Promise<void> {
    const { engine } = this.options
    if (!engine || this.state.phase === 'downloading' || this.state.phase === 'ready') return
    this.setState({ ...this.state, phase: 'downloading', percent: 0 })
    try {
      const found = await engine.checkForUpdates()
      if (found?.updateInfo.version !== version) {
        throw new Error(`the updater found ${found?.updateInfo.version ?? 'nothing'}, expected ${version}`)
      }
      await engine.downloadUpdate()
      this.setState({ ...this.state, phase: 'ready', percent: 100 })
    } catch (error) {
      this.log(`download failed: ${error instanceof Error ? error.message : String(error)}`)
      this.setState({ ...this.state, phase: 'error', percent: 0 })
    }
  }

  /**
   * Runs the downloaded installer and restarts WingLog. Refused while a flight is being tracked,
   * so an update can never close the app under a flight.
   *
   * @returns What happened.
   */
  installAndRestart(): UpdateInstallOutcome {
    const { engine } = this.options
    if (!engine || this.state.phase !== 'ready') return 'notReady'
    if (this.options.isFlightActive()) return 'flightActive'
    engine.quitAndInstall(true, true)
    return 'started'
  }

  private setState(state: UpdateInstallState): void {
    this.state = state
    this.emit('state', state)
  }
}

function toPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0
}
