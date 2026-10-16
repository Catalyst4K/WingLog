/**
 * Storage IPC: the drive's free space and whether saving is failing are **live** (coding-standards.md §9): published to LiveHub,
 * with a getter for a window's first render.
 */
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { LiveHub } from '../live/LiveHub'
import type { DiskSpaceMonitor } from '../storage/disk-space'

/**
 * @param ipcMain Electron's IPC.
 * @param deps The disk monitor and LiveHub.
 */
export function registerStorageHandlers(
  ipcMain: IpcMain,
  {
    monitor,
    liveHub
  }: { monitor: Pick<DiskSpaceMonitor, 'getStatus' | 'on'>; liveHub: Pick<LiveHub, 'publish'> }
): void {
  ipcMain.handle(IpcChannels.storageGetStatus, () => monitor.getStatus())
  monitor.on('status', (status) => liveHub.publish('storageStatus', status))
}
