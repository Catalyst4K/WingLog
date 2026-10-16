/** The low-disk warning: across the top of the app and of the second screen. */

import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import type { StorageStatus } from '@shared/ipc'
import { useLiveTopic } from './live/LiveClient'

const GIB = 1024 ** 3
const UNKNOWN: StorageStatus = { freeBytes: null, level: 'ok', saveFailing: false }

/**
 * "Your disk is running low", from the drive's free space as main reads it (main/storage/disk-space.ts). Shown on every screen, at
 * any time (not only while flying): the launch backup, a download and a long flight's track all need room, and a full disk lost seven
 * hours of an overnight flight (2026-10-16). Red once it is almost full or saving is failing; amber while there is still room to act.
 *
 * @returns The banner, or null while there is plenty of room.
 */
export function StorageBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useLiveTopic('storageStatus', UNKNOWN)
  if (status.level === 'ok' && !status.saveFailing) return null

  const free = status.freeBytes === null ? '' : `${(status.freeBytes / GIB).toFixed(1)} GB`
  const urgent = status.saveFailing || status.level === 'critical'
  const message = status.saveFailing
    ? t('storage.saveFailing')
    : status.level === 'critical'
      ? t('storage.critical', { free })
      : t('storage.low', { free })

  return (
    <section
      role="alert"
      aria-label={t('storage.label')}
      className={
        urgent
          ? 'flex items-center gap-2 bg-destructive px-4 py-2 text-sm text-white'
          : 'flex items-center gap-2 border-b border-border bg-amber-500/20 px-4 py-2 text-sm text-foreground'
      }
    >
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
      <span>{message}</span>
    </section>
  )
}
