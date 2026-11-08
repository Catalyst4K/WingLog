/**
 * Settings → Sim PC → Other WingLogs: let another WingLog on the home network pair with this one as a twin (winglog-backend's
 * docs/plans/multi-device.md). Separate from Second screen: a twin keeps its own logbook and fleet in step with this one and works as this
 * PC's WingLog does, where a second screen is only a window onto the flight.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanDevice, LanPairing, LanStatus } from '@shared/ipc'
import { formatPairingText } from '@shared/host-address'
import { Button } from '@/components/ui/button'
import { winglogApi } from '../data/winglog-api'
import { asyncHandler, runAsync } from '../report-error'
import { OnOffControl, SettingRow, SettingsCard, SettingsSection, StatusBadge } from './ui/SettingsCard'

/** How often the card re-reads the status, for the pairing countdown and the paired list. */
const REFRESH_MS = 2000

/**
 * @param url The server's page address, such as `http://192.168.1.20:8765/`.
 * @returns Its `host:port`, which is what a twin is given to connect to.
 */
function hostPort(url: string): string {
  return new URL(url).host
}

/**
 * The address, and the pairing code with its Copy and Close buttons, or the button that opens a code.
 *
 * @param props The address, the open code if there is one, and what to do with the status a call comes back with.
 * @returns The rows.
 */
function TwinPairing(props: {
  address: string
  pairing: LanPairing | null
  onStatus: (status: LanStatus) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const { address, pairing } = props
  const copy = asyncHandler('TwinCard copy pairing text', async () => {
    if (!pairing) return
    await navigator.clipboard.writeText(formatPairingText(address, pairing.code))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  })
  return (
    <>
      <SettingRow label={t('settingsView.twin.address')}>
        <code className="w-fit rounded bg-muted px-2 py-1 font-mono text-sm">{address}</code>
      </SettingRow>
      <SettingRow
        label={pairing ? t('settingsView.twin.pairingCode') : t('settingsView.twin.pairButton')}
        note={pairing ? t('settingsView.twin.pairingNote') : undefined}
        stacked
      >
        {pairing ? (
          <div className="flex flex-col gap-2">
            <span className="font-mono text-3xl tracking-widest" aria-label={pairing.code}>
              {pairing.code}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={copy}>
                {copied ? t('settingsView.twin.copied') : t('settingsView.twin.copy')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  runAsync(
                    'TwinCard lanStopPairing',
                    winglogApi().lanStopPairing('twin').then(props.onStatus)
                  )
                }
              >
                {t('settingsView.twin.close')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() =>
              runAsync('TwinCard lanStartPairing', winglogApi().lanStartPairing('twin').then(props.onStatus))
            }
          >
            {t('settingsView.twin.pairButton')}
          </Button>
        )}
      </SettingRow>
    </>
  )
}

/**
 * The paired WingLogs, each with a Revoke button.
 *
 * @param props The paired twins, and what to do with the status a revoke comes back with.
 * @returns The section.
 */
function TwinDevices(props: {
  twins: LanDevice[]
  onStatus: (status: LanStatus) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection title={t('settingsView.twin.devices')}>
      {props.twins.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settingsView.twin.noDevices')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {props.twins.map((device) => (
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
                onClick={() =>
                  runAsync(
                    'TwinCard lanRevokeDevice',
                    winglogApi().lanRevokeDevice(device.id).then(props.onStatus)
                  )
                }
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
 * The Other WingLogs card: its own switch, its own pairing code and its own list of paired WingLogs.
 *
 * @returns The element.
 */
export function TwinCard(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<LanStatus | null>(null)

  const refresh = useCallback(() => {
    runAsync('TwinCard lanGetStatus', winglogApi().lanGetStatus().then(setStatus))
  }, [])
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  if (!status) return <SettingsCard title={t('settingsView.twin.cardTitle')} />

  const { twinEnabled } = status.settings
  const twins = status.devices.filter((device) => device.kind === 'twin')
  const address = status.url ? hostPort(status.url) : null

  return (
    <SettingsCard
      title={t('settingsView.twin.cardTitle')}
      description={t('settingsView.twin.description')}
      status={
        twinEnabled &&
        address && (
          <StatusBadge
            state={twins.length > 0 ? 'connected' : 'disconnected'}
            label={t('settingsView.twin.paired', { count: twins.length })}
          />
        )
      }
    >
      <SettingRow label={t('settingsView.twin.enable')}>
        <OnOffControl
          label={t('settingsView.twin.enable')}
          enabled={twinEnabled}
          onText={t('lan.settings.on')}
          offText={t('lan.settings.off')}
          onChange={(enabled) =>
            runAsync(
              'TwinCard lanSetSettings',
              winglogApi().lanSetSettings({ twinEnabled: enabled }).then(setStatus)
            )
          }
        />
      </SettingRow>
      {twinEnabled && !address && (
        <p className="text-sm text-muted-foreground">{t('settingsView.twin.notReachable')}</p>
      )}
      {twinEnabled && address && (
        <TwinPairing address={address} pairing={status.twinPairing} onStatus={setStatus} />
      )}
      {twinEnabled && <TwinDevices twins={twins} onStatus={setStatus} />}
    </SettingsCard>
  )
}
