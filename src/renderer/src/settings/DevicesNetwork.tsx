/**
 * Settings → Devices on the sim PC: "On your home network", the switch for computers and the one for phones and tablets, the port, the
 * address devices reach this PC on, and why they cannot when they cannot (winglog-backend's docs/plans/devices-page.md, step 3).
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanSettings, LanStatus } from '@shared/ipc'
import { Input } from '@/components/ui/input'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import { OnOffControl, SettingRow, SettingsCard } from './ui/SettingsCard'

/** The lowest and highest port the server may use: above the privileged ones (the main process checks the same). */
const MIN_PORT = 1024
const MAX_PORT = 65535

/** The locale key under `lan.settings.problem` for each problem. */
const PROBLEM_KEY = {
  'no-adapter': 'noAdapter',
  'port-in-use': 'portInUse',
  failed: 'failed'
} as const

/**
 * The port field: digits only, saved when it loses focus if it is a good port, put back to the saved one if it is not. Keyed by the saved
 * port, so a port saved elsewhere shows.
 *
 * @param props The saved port, and what saving a new one does.
 * @returns The row.
 */
function PortRow(props: { port: number; onSave: (port: number) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const [port, setPort] = useState(String(props.port))
  const value = Number(port)
  const valid = Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT
  return (
    <SettingRow label={t('lan.settings.port')} note={t('settingsView.devices.portHint')} controlId={id}>
      <Input
        id={id}
        className="w-24 font-mono"
        inputMode="numeric"
        value={port}
        aria-invalid={!valid}
        onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))}
        onBlur={() => {
          if (valid && value !== props.port) props.onSave(value)
          else if (!valid) setPort(String(props.port))
        }}
      />
    </SettingRow>
  )
}

/**
 * What stops devices connecting, if anything: the server's own problem, no home network for computers, or no certificate for them.
 *
 * @param props The status.
 * @returns The lines, or nothing when all is well.
 */
function NetworkProblems(props: { status: LanStatus }): React.JSX.Element | null {
  const { t } = useTranslation()
  const { settings, url, problem, twinCertificate } = props.status
  const lines: string[] = []
  if (problem) lines.push(t(`lan.settings.problem.${PROBLEM_KEY[problem]}`))
  else if (settings.twinEnabled && !url) lines.push(t('settingsView.twin.notReachable'))
  if (settings.twinEnabled && url && !twinCertificate) lines.push(t('settingsView.twin.noCertificate'))
  if (lines.length === 0) return null
  return (
    <>
      {lines.map((line) => (
        <p key={line} role="alert" className="m-0 flex items-center text-sm text-destructive">
          {line}
        </p>
      ))}
    </>
  )
}

/**
 * The network section. Each switch sends only its own setting, so the other is never overwritten with a stale value.
 *
 * @param props The status, whether this build pairs computers (multi-device), and what to do with the status a change comes back with.
 * @returns The section.
 */
export function DevicesNetwork(props: {
  status: LanStatus
  multiDevice: boolean
  onStatus: (status: LanStatus) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { status } = props
  const { settings } = status
  const save = (patch: Partial<LanSettings>): void =>
    runAsync('DevicesPage lanSetSettings', winglogApi().lanSetSettings(patch).then(props.onStatus))
  const on = settings.enabled || (props.multiDevice && settings.twinEnabled)
  return (
    <SettingsCard title={t('settingsView.devices.networkTitle')}>
      {props.multiDevice && (
        <SettingRow
          label={t('settingsView.devices.computers')}
          note={t('settingsView.devices.computersHint')}
        >
          <OnOffControl
            label={t('settingsView.devices.computers')}
            enabled={settings.twinEnabled}
            onText={t('lan.settings.on')}
            offText={t('lan.settings.off')}
            onChange={(twinEnabled) => save({ twinEnabled })}
          />
        </SettingRow>
      )}
      <SettingRow label={t('settingsView.devices.phones')} note={t('settingsView.devices.phonesHint')}>
        <OnOffControl
          label={t('settingsView.devices.phones')}
          enabled={settings.enabled}
          onText={t('lan.settings.on')}
          offText={t('lan.settings.off')}
          onChange={(enabled) => save({ enabled })}
        />
      </SettingRow>
      {on && <PortRow key={settings.port} port={settings.port} onSave={(port) => save({ port })} />}
      {on && status.url && (
        <SettingRow label={t('settingsView.devices.address')} note={t('settingsView.devices.addressHint')}>
          <code className="font-mono text-sm">{status.url}</code>
        </SettingRow>
      )}
      {on && <NetworkProblems status={status} />}
      {on && (
        <p className="m-0 flex items-center text-[13px] text-muted-foreground">{t('lan.settings.help')}</p>
      )}
    </SettingsCard>
  )
}
