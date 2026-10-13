/** Settings → Data → Second screen: the live map on a phone or tablet (winglog-backend's docs/plans/lan-web-viewer.md). */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanSettings, LanStatus } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { winglogApi } from '../data/winglog-api'
import { QrCode } from './QrCode'
import { asyncHandler, runAsync } from '../report-error'
import { OnOffControl, SettingRow, SettingsCard, SettingsSection, StatusBadge } from './ui/SettingsCard'

/** How often the card re-reads the status, for the pairing countdown, devices and connections. */
const REFRESH_MS = 2000

/**
 * The second-screen card: the switch, the network and port, the address to open, pairing and the paired devices.
 *
 * @returns The element.
 */
export function LanCard(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<LanStatus | null>(null)
  const [port, setPort] = useState('')
  const portId = useId()
  // Pairing mode, from pressing "Pair a device" until "Close": a code that runs out or is used is replaced by a new one (so a QR left on
  // screen never goes stale, and a second device can follow the first), but a window cancelled by wrong guesses is not reopened.
  const pairing = useRef<{ on: boolean; expiresAt: number; devices: number }>({
    on: false,
    expiresAt: 0,
    devices: 0
  })

  const refresh = useCallback(() => {
    runAsync(
      'LanCard lanGetStatus',
      winglogApi()
        .lanGetStatus()
        .then((next) => {
          setStatus(next)
          setPort((current) => (current === '' ? String(next.settings.port) : current))
          renewPairing(next, pairing.current, setStatus)
        })
    )
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  /**
   * Sends a change and shows the status it comes back with.
   *
   * @param action The call to make.
   * @param context What it does, for the log.
   * @returns A click handler.
   */
  const change = (action: () => Promise<LanStatus>, context: string) =>
    asyncHandler(context, async () => setStatus(await action()))

  if (!status) return <SettingsCard title={t('lan.settings.title')} />
  /** Opens pairing mode: a code now, and a new one whenever it runs out or is used, until Close. */
  function startPairing(): void {
    pairing.current = { on: true, expiresAt: 0, devices: status?.devices.length ?? 0 }
    runAsync('LanCard lanStartPairing', winglogApi().lanStartPairing().then(setStatus))
  }
  /** Closes pairing mode. */
  function stopPairing(): void {
    pairing.current.on = false
    runAsync('LanCard lanStopPairing', winglogApi().lanStopPairing().then(setStatus))
  }
  const { settings } = status
  const save = (patch: Partial<LanSettings>): Promise<LanStatus> =>
    winglogApi().lanSetSettings({ ...settings, ...patch })
  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535

  return (
    <SettingsCard
      title={t('lan.settings.title')}
      status={
        status.url && (
          <StatusBadge state="connected" label={t('lan.settings.connected', { count: status.connections })} />
        )
      }
      description={t('lan.settings.description')}
    >
      <SettingRow label={t('lan.settings.enable')}>
        <OnOffControl
          label={t('lan.settings.enable')}
          enabled={settings.enabled}
          onText={t('lan.settings.on')}
          offText={t('lan.settings.off')}
          onChange={(enabled) => change(() => save({ enabled }), 'LanCard lanSetSettings')()}
        />
      </SettingRow>

      {settings.enabled && (
        <>
          <SettingRow label={t('lan.settings.port')} controlId={portId}>
            <Input
              id={portId}
              className="w-24"
              inputMode="numeric"
              value={port}
              aria-invalid={!portValid}
              onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))}
              onBlur={() => {
                if (portValid && portNumber !== settings.port) {
                  runAsync('LanCard lanSetSettings', save({ port: portNumber }).then(setStatus))
                } else if (!portValid) {
                  setPort(String(settings.port))
                }
              }}
            />
          </SettingRow>

          {status.problem && (
            <p role="alert" className="text-sm text-destructive">
              {t(`lan.settings.problem.${PROBLEM_KEY[status.problem]}`)}
            </p>
          )}

          {status.url && status.pairing && (
            <SettingRow label={t('lan.settings.open')}>
              <code className="w-fit rounded bg-muted px-2 py-1 font-mono text-sm">{status.url}</code>
            </SettingRow>
          )}

          {status.url && (
            <SettingRow
              label={status.pairing ? t('lan.settings.pairingCode') : t('lan.settings.pairButton')}
              note={status.pairing ? t('lan.settings.pairingNote') : undefined}
              stacked
            >
              <div className="flex flex-wrap items-center gap-4">
                <div className="relative overflow-hidden rounded-md">
                  <QrCode
                    text={status.pairing ? `${status.url}#code=${status.pairing.code}` : status.url}
                    label={t('lan.settings.qrLabel')}
                    blurred={!status.pairing}
                  />
                  {!status.pairing && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Button type="button" size="sm" onClick={startPairing}>
                        {t('lan.settings.pairButton')}
                      </Button>
                    </div>
                  )}
                </div>
                {status.pairing && (
                  <div className="flex flex-col gap-2">
                    <span className="font-mono text-3xl tracking-widest" aria-label={status.pairing.code}>
                      {status.pairing.code}
                    </span>
                    <span className="max-w-52 text-xs text-muted-foreground">
                      {t('lan.settings.qrHintPairing')}
                    </span>
                    <div>
                      <Button type="button" size="sm" variant="outline" onClick={stopPairing}>
                        {t('lan.settings.pairingClose')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </SettingRow>
          )}

          <PairedDevices
            status={status}
            onRevoke={(id) => change(() => winglogApi().lanRevokeDevice(id), 'LanCard lanRevokeDevice')()}
          />

          <p className="text-xs text-muted-foreground">{t('lan.settings.help')}</p>
        </>
      )}
    </SettingsCard>
  )
}

/**
 * The paired devices, each with a Revoke button.
 *
 * @param props The status, and what pressing Revoke does.
 * @returns The element.
 */
function PairedDevices(props: { status: LanStatus; onRevoke: (id: number) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { status } = props
  return (
    <SettingsSection title={t('lan.settings.devices')}>
      {status.devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('lan.settings.noDevices')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {status.devices.map((device) => (
            <li key={device.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex flex-col">
                <span>{device.name}</span>
                <span className="text-xs text-muted-foreground">
                  {device.lastSeenAt
                    ? t('lan.settings.lastSeen', { when: new Date(device.lastSeenAt).toLocaleString() })
                    : t('lan.settings.neverSeen')}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`${t('lan.settings.revoke')} ${device.name}`}
                onClick={() => props.onRevoke(device.id)}
              >
                {t('lan.settings.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  )
}

/**
 * Keeps the pairing code fresh while the pilot is in pairing mode.
 *
 * @param status The status just read.
 * @param pairing Whether pairing mode is on, when the code on screen runs out, and how many devices were paired when it was opened.
 * @param show Shows the status a new code comes back with.
 */
function renewPairing(
  status: LanStatus,
  pairing: { on: boolean; expiresAt: number; devices: number },
  show: (next: LanStatus) => void
): void {
  if (!pairing.on) return
  if (!status.url) {
    pairing.on = false
    return
  }
  if (status.pairing) {
    pairing.expiresAt = status.pairing.expiresAt
    return
  }
  const used = status.devices.length > pairing.devices
  const expired = pairing.expiresAt !== 0 && Date.now() >= pairing.expiresAt
  if (used || expired) {
    pairing.devices = status.devices.length
    runAsync('LanCard lanStartPairing (renew)', winglogApi().lanStartPairing().then(show))
  } else {
    // Gone before its time and nobody paired: the PC cancelled it after wrong guesses, so stop offering codes.
    pairing.on = false
  }
}

/** The locale key under `lan.settings.problem` for each problem. */
const PROBLEM_KEY = {
  'no-adapter': 'noAdapter',
  'port-in-use': 'portInUse',
  failed: 'failed'
} as const
