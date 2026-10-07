/**
 * Cloud sync (winglog-backend/docs/plans/cloud-sync.md): the debounced background sync that
 * follows each local change, and the account and sync IPC. Every channel is a query
 * (coding-standards.md §9) between this device's database and the backend.
 */
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { CloudSyncController } from '../sync/cloud-sync-controller'

/** How long after the last local change the background sync runs, in milliseconds. */
export const BACKGROUND_SYNC_DELAY_MS = 2000

/**
 * The push-on-mutation half of cloud sync (winglog-backend/docs/plans/cloud-sync-v2.md #3).
 *
 * Debounced rather than one sync per write, so a burst (a fleet import, a fast sequence of
 * tracking writes) doesn't fire a sync per row. syncNow() is already a full pull-then-push cycle
 * across all four tables, reusing the same cursor-based mechanism "Sync now" and pull-on-launch
 * use rather than a bespoke single-row push path, per the coding standards' simple-over-clever
 * principle. Offline is the normal case, not the exception: a failed attempt just leaves
 * lastSyncedAt where it was, so the very next successful sync (the next write, app relaunch, or
 * manual "Sync now") naturally re-covers whatever this one missed — no separate retry/outbox
 * needed.
 *
 * @param cloudSync The sync controller.
 * @returns `scheduleBackgroundSync`: call after any local change; a no-op when signed out.
 */
export function createBackgroundSync(
  cloudSync: Pick<CloudSyncController, 'getStatus' | 'syncNow'>
): () => void {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (!cloudSync.getStatus().loggedIn) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void cloudSync.syncNow(), BACKGROUND_SYNC_DELAY_MS)
  }
}

/**
 * Registers the account and sync channels — only when the build has cloud sync
 * (docs/plans/public-release-v1.md, Decision 1), which public builds don't. The controller still
 * runs in a public build (pull-on-launch and background sync stay harmless when signed out, which
 * a public build always is: there's no public signup route to have got an account through), but
 * these five channels, the only way to sign in or trigger a sync, don't exist at all rather than
 * existing and refusing. See src/shared/build-flags.d.ts.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The sync controller, and whether this build has cloud sync.
 */
export function registerSyncHandlers(
  ipcMain: IpcMain,
  { cloudSync, enabled }: { cloudSync: CloudSyncController; enabled: boolean }
): void {
  if (!enabled) return
  ipcMain.handle(IpcChannels.authLogin, (_event, email: string, password: string) =>
    cloudSync.login(email, password)
  )
  ipcMain.handle(IpcChannels.authSignup, (_event, email: string, password: string, inviteCode: string) =>
    cloudSync.signup(email, password, inviteCode)
  )
  ipcMain.handle(IpcChannels.authLogout, () => cloudSync.logout())
  ipcMain.handle(IpcChannels.syncNow, () => cloudSync.syncNow())
  ipcMain.handle(IpcChannels.syncStatus, () => cloudSync.getStatus())
}
