/** Settings → Data: Fleet and Logbook import and export, and cloud sync. */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { DataFormat } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedRow } from '../SettingsFields'
import { asyncHandler } from '../report-error'
import { SettingRow, SettingsCard, SettingsSection } from './ui/SettingsCard'
import type { CloudSyncState, DataTransferState } from './use-settings-state'

const DATA_FORMATS = [
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' }
] as const

/**
 * One Import/Export pair with its own format picker — Fleet and Logbook each get one
 * (winglog-backend docs/plans/data-export-import.md).
 *
 * @param props The section's title and hint, the file format, and the import and export handlers.
 * @returns The element.
 */
function DataSection(props: {
  title: string
  hint: string
  format: DataFormat
  onFormatChange: (format: DataFormat) => void
  importing: boolean
  onImport: () => void
  onExport: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection
      title={props.title}
      ariaLabel={t('settingsView.data.regionLabel', { title: props.title })}
      action={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onImport}
            disabled={props.importing}
          >
            {props.importing ? t('settingsView.data.importing') : t('settingsView.data.import')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={props.onExport}>
            {t('settingsView.data.export')}
          </Button>
        </>
      }
    >
      <p className="text-xs text-muted-foreground">{props.hint}</p>
      <SegmentedRow
        label={t('settingsView.data.fileFormat')}
        value={props.format}
        options={DATA_FORMATS}
        onChange={props.onFormatChange}
      />
    </SettingsSection>
  )
}

/**
 * Fleet and Logbook import and export.
 *
 * @param props The data transfer's state and actions.
 * @returns The element.
 */
export function DataCard(props: { data: DataTransferState }): React.JSX.Element {
  const { t } = useTranslation()
  const d = props.data
  return (
    <SettingsCard title={t('settingsView.data.cardTitle')} description={t('settingsView.data.description')}>
      <DataSection
        title={t('settingsView.data.fleetTitle')}
        hint={t('settingsView.data.fleetHint')}
        format={d.fleetFormat}
        onFormatChange={d.setFleetFormat}
        importing={d.importingAircraft}
        onImport={asyncHandler('SettingsView handleImportAircraft', d.importAircraft)}
        onExport={asyncHandler('SettingsView handleExportAircraft', d.exportAircraft)}
      />
      <DataSection
        title={t('settingsView.data.logbookTitle')}
        hint={t('settingsView.data.logbookHint')}
        format={d.logbookFormat}
        onFormatChange={d.setLogbookFormat}
        importing={d.importingLogbook}
        onImport={asyncHandler('SettingsView handleImportLogbook', d.importLogbook)}
        onExport={asyncHandler('SettingsView handleExportLogbook', d.exportLogbook)}
      />
    </SettingsCard>
  )
}

/**
 * The signed-in account: who, when it last synced, and Sync now.
 *
 * @param props The cloud sync's state and actions.
 * @returns The element.
 */
function CloudAccount(props: { sync: CloudSyncState }): React.JSX.Element {
  const { t } = useTranslation()
  const { status } = props.sync
  return (
    <>
      <SettingRow label={status.email ?? ''}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={asyncHandler('SettingsView handleCloudLogout', props.sync.logOut)}
        >
          {t('settingsView.cloudSync.logOut')}
        </Button>
      </SettingRow>
      <SettingRow
        label={
          status.lastSyncedAt
            ? t('settingsView.cloudSync.lastSynced', { date: new Date(status.lastSyncedAt).toLocaleString() })
            : t('settingsView.cloudSync.neverSyncedYet')
        }
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={asyncHandler('SettingsView handleSyncNow', props.sync.syncNow)}
          disabled={status.syncing}
        >
          {status.syncing ? t('settingsView.cloudSync.syncing') : t('settingsView.cloudSync.syncNow')}
        </Button>
      </SettingRow>
      {status.lastError && (
        <p role="alert" className="text-xs text-destructive">
          {status.lastError}
        </p>
      )}
    </>
  )
}

/**
 * The log-in / sign-up form.
 *
 * @param props The cloud sync's state and actions.
 * @returns The element.
 */
function CloudSignIn(props: { sync: CloudSyncState }): React.JSX.Element {
  const { t } = useTranslation()
  const s = props.sync
  const emailId = useId()
  const passwordId = useId()
  const inviteId = useId()
  const submitLabel = s.submitting
    ? s.mode === 'login'
      ? t('settingsView.cloudSync.loggingIn')
      : t('settingsView.cloudSync.signingUp')
    : s.mode === 'login'
      ? t('settingsView.cloudSync.logIn')
      : t('settingsView.cloudSync.signUp')
  return (
    <>
      <div className="flex gap-1.5" role="group" aria-label={t('settingsView.cloudSync.cardTitle')}>
        {(['login', 'signup'] as const).map((mode) => (
          <Button
            key={mode}
            type="button"
            size="sm"
            variant={s.mode === mode ? 'default' : 'outline'}
            aria-pressed={s.mode === mode}
            className="min-w-[4.5rem]"
            onClick={() => s.setMode(mode)}
          >
            {t(mode === 'login' ? 'settingsView.cloudSync.logIn' : 'settingsView.cloudSync.signUp')}
          </Button>
        ))}
      </div>
      <form
        onSubmit={asyncHandler('SettingsView handleCloudLogin', s.mode === 'login' ? s.logIn : s.signUp)}
        className="flex flex-col gap-3"
      >
        <SettingRow label={t('settingsView.cloudSync.email')} controlId={emailId}>
          <Input
            id={emailId}
            className="w-64"
            type="email"
            value={s.email}
            onChange={(e) => s.setEmail(e.target.value)}
            required
          />
        </SettingRow>
        <SettingRow
          label={t('settingsView.cloudSync.password')}
          note={s.mode === 'signup' ? t('settingsView.cloudSync.atLeast12Chars') : undefined}
          controlId={passwordId}
        >
          <Input
            id={passwordId}
            className="w-64"
            type="password"
            value={s.password}
            onChange={(e) => s.setPassword(e.target.value)}
            minLength={s.mode === 'signup' ? 12 : undefined}
            required
          />
        </SettingRow>
        {s.mode === 'signup' && (
          <SettingRow
            label={t('settingsView.cloudSync.inviteCode')}
            note={t('settingsView.cloudSync.signupHint')}
            controlId={inviteId}
          >
            <Input
              id={inviteId}
              className="w-64"
              type="password"
              value={s.inviteCode}
              onChange={(e) => s.setInviteCode(e.target.value)}
              required
            />
          </SettingRow>
        )}
        <Button type="submit" variant="outline" size="sm" className="self-end" disabled={s.submitting}>
          {submitLabel}
        </Button>
      </form>
    </>
  )
}

/**
 * Cloud sync: the account when signed in, otherwise the sign-in form.
 *
 * @param props The cloud sync's state and actions.
 * @returns The element.
 */
export function CloudSyncCard(props: { sync: CloudSyncState }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsCard
      title={t('settingsView.cloudSync.cardTitle')}
      description={t('settingsView.cloudSync.description')}
    >
      {props.sync.status.loggedIn ? <CloudAccount sync={props.sync} /> : <CloudSignIn sync={props.sync} />}
    </SettingsCard>
  )
}
