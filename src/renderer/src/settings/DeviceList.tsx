/**
 * Settings → Devices on the sim PC: "Paired with this PC", one list of every paired computer and phone with its light, and Remove
 * (winglog-backend's docs/plans/devices-page.md, step 3; the canvas's dev-r1-a-list).
 */

import { useTranslation } from 'react-i18next'
import type { LanDevice, LanStatus } from '@shared/ipc'
import { StatusLight } from '@/components/StatusLight'
import { Button } from '@/components/ui/button'
import { winglogApi } from '../data/winglog-api'
import { useConfirm } from '../hooks/use-confirm'
import { asyncHandler } from '../report-error'
import { SettingsCard } from './ui/SettingsCard'

/**
 * @param device A paired device.
 * @param t The translation function.
 * @returns What the row says of its connection: connected now, when it was last seen, or that it never connected.
 */
function deviceState(
  device: LanDevice,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (device.connected) return t('settingsView.devices.connected')
  return device.lastSeenAt
    ? t('lan.settings.lastSeen', { when: new Date(device.lastSeenAt).toLocaleString() })
    : t('lan.settings.neverSeen')
}

/**
 * One paired device: its light (green while connected, a hollow ring otherwise), its name and kind, its state and its actions.
 *
 * @param props The device, and what pressing Remove does.
 * @returns The row.
 */
function DeviceRow(props: { device: LanDevice; onRemove: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { device } = props
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 min-h-16">
      <StatusLight state={device.connected ? 'green' : 'off'} hollow />
      <div className="flex min-w-0 flex-1 basis-60 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="font-display font-semibold tracking-[-0.01em]">{device.name}</span>
        <span className="text-[13px] text-muted-foreground">
          {t(`settingsView.devices.kind.${device.kind}`)}
        </span>
      </div>
      <span className="text-sm text-muted-foreground">{deviceState(device, t)}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={t('settingsView.devices.removeNamed', { name: device.name })}
        onClick={props.onRemove}
      >
        {t('settingsView.devices.remove')}
      </Button>
    </div>
  )
}

/**
 * The list of everything paired with this PC, twins and phones together, oldest first.
 *
 * @param props The server's status, and what to do with the status a change comes back with.
 * @returns The section.
 */
export function DeviceList(props: {
  status: LanStatus
  onStatus: (status: LanStatus) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirm, confirmDialog] = useConfirm()
  const remove = (device: LanDevice): (() => void) =>
    asyncHandler('DevicesPage lanRevokeDevice', async () => {
      const ok = await confirm({
        title: t('settingsView.devices.removeTitle', { name: device.name }),
        description: t('settingsView.devices.removeBody'),
        confirmLabel: t('settingsView.devices.remove'),
        cancelLabel: t('settingsView.devices.cancel'),
        destructive: true
      })
      if (ok) props.onStatus(await winglogApi().lanRevokeDevice(device.id))
    })
  const { devices } = props.status
  return (
    <>
      <SettingsCard title={t('settingsView.devices.pairedTitle')}>
        {devices.length === 0 ? (
          <p className="m-0 flex items-center text-sm text-muted-foreground">
            {t('settingsView.devices.nothingPaired')}
          </p>
        ) : (
          devices.map((device) => <DeviceRow key={device.id} device={device} onRemove={remove(device)} />)
        )}
      </SettingsCard>
      {confirmDialog}
    </>
  )
}
