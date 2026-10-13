/** Settings → Data → Second screen: the live map on a phone or tablet (winglog-backend's docs/plans/lan-web-viewer.md). */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanSettings, LanStatus } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { winglogApi } from '../data/winglog-api'
import { QrCode } from './QrCode'
import { asyncHandler, runAsync } from '../report-error'

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

  const refresh = useCallback(() => {
    runAsync(
      'LanCard lanGetStatus',
      winglogApi()
        .lanGetStatus()
        .then((next) => {
          setStatus(next)
          setPort((current) => (current === '' ? String(next.settings.port) : current))
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

  if (!status) return <Card className="w-full max-w-2xl" />
  const { settings } = status
  const save = (patch: Partial<LanSettings>): Promise<LanStatus> =>
    winglogApi().lanSetSettings({ ...settings, ...patch })
  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>{t('lan.settings.title')}</CardTitle>
        <CardDescription>{t('lan.settings.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted-foreground">{t('lan.settings.enable')}</span>
          <div className="flex gap-1.5" role="group" aria-label={t('lan.settings.enable')}>
            {[true, false].map((value) => (
              <Button
                key={String(value)}
                type="button"
                size="sm"
                variant={settings.enabled === value ? 'default' : 'outline'}
                aria-pressed={settings.enabled === value}
                onClick={change(() => save({ enabled: value }), 'LanCard lanSetSettings')}
              >
                {value ? t('lan.settings.on') : t('lan.settings.off')}
              </Button>
            ))}
          </div>
        </div>

        {settings.enabled && (
          <>
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                {t('lan.settings.adapter')}
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                  value={settings.adapter ?? ''}
                  onChange={(event) =>
                    runAsync(
                      'LanCard lanSetSettings',
                      save({ adapter: event.target.value || null }).then(setStatus)
                    )
                  }
                >
                  <option value="">{t('lan.settings.adapterAuto')}</option>
                  {status.addresses.map((a) => (
                    <option key={a.adapter} value={a.adapter}>
                      {t(a.virtual ? 'lan.settings.adapterVirtual' : 'lan.settings.adapterOption', {
                        adapter: a.adapter,
                        address: a.address
                      })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                {t('lan.settings.port')}
                <Input
                  className="h-8 w-24"
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
              </label>
            </div>

            {status.problem && (
              <p role="alert" className="text-sm text-destructive">
                {t(`lan.settings.problem.${PROBLEM_KEY[status.problem]}`)}
              </p>
            )}

            {status.url && (
              <div className="flex flex-wrap items-start gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-sm text-muted-foreground">{t('lan.settings.open')}</span>
                  <code className="w-fit rounded bg-muted px-2 py-1 font-mono text-sm">{status.url}</code>
                  <span className="text-xs text-muted-foreground">
                    {t('lan.settings.connected', { count: status.connections })}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <QrCode text={status.url} label={t('lan.settings.qrLabel')} />
                  <span className="max-w-44 text-xs text-muted-foreground">{t('lan.settings.qrHint')}</span>
                </div>
              </div>
            )}

            {status.url && (
              <div className="flex flex-col gap-2">
                {status.pairing ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm text-muted-foreground">{t('lan.settings.pairingCode')}</span>
                    <span className="font-mono text-3xl tracking-widest" aria-label={status.pairing.code}>
                      {status.pairing.code}
                    </span>
                    <span className="text-xs text-muted-foreground">{t('lan.settings.pairingNote')}</span>
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={change(() => winglogApi().lanStopPairing(), 'LanCard lanStopPairing')}
                      >
                        {t('lan.settings.pairingClose')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={change(() => winglogApi().lanStartPairing(), 'LanCard lanStartPairing')}
                    >
                      {t('lan.settings.pairButton')}
                    </Button>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('lan.settings.devices')}</span>
              {status.devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('lan.settings.noDevices')}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {status.devices.map((device) => (
                    <li key={device.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex flex-col">
                        <span>{device.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {device.lastSeenAt
                            ? t('lan.settings.lastSeen', {
                                when: new Date(device.lastSeenAt).toLocaleString()
                              })
                            : t('lan.settings.neverSeen')}
                        </span>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`${t('lan.settings.revoke')} ${device.name}`}
                        onClick={change(
                          () => winglogApi().lanRevokeDevice(device.id),
                          'LanCard lanRevokeDevice'
                        )}
                      >
                        {t('lan.settings.revoke')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="text-xs text-muted-foreground">{t('lan.settings.help')}</p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** The locale key under `lan.settings.problem` for each problem. */
const PROBLEM_KEY = {
  'no-adapter': 'noAdapter',
  'choose-adapter': 'chooseAdapter',
  'port-in-use': 'portInUse',
  failed: 'failed'
} as const
