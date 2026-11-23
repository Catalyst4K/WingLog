/**
 * Settings → Devices on the sim PC: "Paired with this PC", one list of every paired computer and phone with its light, Rename and Remove
 * (winglog-backend's docs/plans/devices-page.md, steps 3 and 5; the canvas's dev-r1-a-list).
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanDevice, LanStatus } from '@shared/ipc'
import { StatusLight } from '@/components/StatusLight'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { winglogApi } from '../data/winglog-api'
import { useConfirm } from '../hooks/use-confirm'
import { asyncHandler, runAsync } from '../report-error'
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

/** The longest name a device can be given, in characters (the main process refuses longer). */
const MAX_NAME_CHARS = 40

/**
 * The name being edited: a text field with Save and Cancel. Enter saves and Escape cancels; an empty or unchanged name sends nothing.
 *
 * @param props The name now, and what saving a new one and cancelling do.
 * @returns The field and its buttons.
 */
function NameEditor(props: {
  name: string
  onSave: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(props.name)
  function save(): void {
    const name = value.trim()
    if (name === '' || name === props.name) props.onCancel()
    else props.onSave(name)
  }
  return (
    <div className="flex min-w-0 flex-1 basis-60 flex-wrap items-center gap-2">
      <Input
        aria-label={t('settingsView.devices.nameLabel')}
        value={value}
        maxLength={MAX_NAME_CHARS}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
          if (event.key === 'Escape') {
            // Escape here cancels the edit; it must not also close anything around the list.
            event.stopPropagation()
            props.onCancel()
          }
        }}
        className="w-60 font-display font-semibold"
      />
      <Button type="button" size="sm" onClick={save}>
        {t('settingsView.devices.save')}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={props.onCancel}>
        {t('settingsView.devices.cancel')}
      </Button>
    </div>
  )
}

/**
 * One paired device: its light (green while connected, a hollow ring otherwise), its name and kind, its state and its actions.
 *
 * @param props The device, and what saving a new name and pressing Remove do.
 * @returns The row.
 */
function DeviceRow(props: {
  device: LanDevice
  onRename: (name: string) => void
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { device } = props
  const [editing, setEditing] = useState(false)
  return (
    <div className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2">
      <StatusLight state={device.connected ? 'green' : 'off'} hollow />
      {editing ? (
        <NameEditor
          name={device.name}
          onSave={(name) => {
            setEditing(false)
            props.onRename(name)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="flex min-w-0 flex-1 basis-60 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="font-display font-semibold tracking-[-0.01em]">{device.name}</span>
          <span className="text-[13px] text-muted-foreground">
            {t(`settingsView.devices.kind.${device.kind}`)}
          </span>
        </div>
      )}
      <span className="text-sm text-muted-foreground">{deviceState(device, t)}</span>
      {!editing && (
        <span className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('settingsView.devices.renameNamed', { name: device.name })}
            onClick={() => setEditing(true)}
          >
            {t('settingsView.devices.rename')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('settingsView.devices.removeNamed', { name: device.name })}
            onClick={props.onRemove}
          >
            {t('settingsView.devices.remove')}
          </Button>
        </span>
      )}
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
  const rename = (device: LanDevice, name: string): void =>
    runAsync(
      'DevicesPage lanRenameDevice',
      winglogApi().lanRenameDevice(device.id, name).then(props.onStatus)
    )
  const { devices } = props.status
  return (
    <>
      <SettingsCard title={t('settingsView.devices.pairedTitle')}>
        {devices.length === 0 ? (
          <p className="m-0 flex items-center text-sm text-muted-foreground">
            {t('settingsView.devices.nothingPaired')}
          </p>
        ) : (
          devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              onRename={(name) => rename(device, name)}
              onRemove={remove(device)}
            />
          ))
        )}
      </SettingsCard>
      {confirmDialog}
    </>
  )
}
