/** Settings → Data: Fleet and Logbook import and export, and cloud sync. */

import { useTranslation } from 'react-i18next'
import type { DataFormat } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedRow } from '../SettingsFields'
import { asyncHandler } from '../report-error'
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
    <section
      aria-label={t('settingsView.data.regionLabel', { title: props.title })}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{props.title}</span>
        <div className="flex gap-2">
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
        </div>
      </div>
      <SegmentedRow
        label={t('settingsView.data.fileFormat')}
        value={props.format}
        options={DATA_FORMATS}
        onChange={props.onFormatChange}
      />
      <p className="text-xs text-muted-foreground">{props.hint}</p>
    </section>
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
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>{t('settingsView.data.cardTitle')}</CardTitle>
        <CardDescription>{t('settingsView.data.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
      </CardContent>
    </Card>
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
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-foreground">{status.email}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={asyncHandler('SettingsView handleCloudLogout', props.sync.logOut)}
        >
          {t('settingsView.cloudSync.logOut')}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {status.lastSyncedAt
            ? t('settingsView.cloudSync.lastSynced', { date: new Date(status.lastSyncedAt).toLocaleString() })
            : t('settingsView.cloudSync.neverSyncedYet')}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={asyncHandler('SettingsView handleSyncNow', props.sync.syncNow)}
          disabled={status.syncing}
        >
          {status.syncing ? t('settingsView.cloudSync.syncing') : t('settingsView.cloudSync.syncNow')}
        </Button>
      </div>
      {status.lastError && <p className="text-xs text-destructive">{status.lastError}</p>}
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
  const modeClass = (mode: 'login' | 'signup'): string =>
    `flex-1 cursor-pointer rounded-sm py-1 ${s.mode === mode ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground'}`
  const submitLabel = s.submitting
    ? s.mode === 'login'
      ? t('settingsView.cloudSync.loggingIn')
      : t('settingsView.cloudSync.signingUp')
    : s.mode === 'login'
      ? t('settingsView.cloudSync.logIn')
      : t('settingsView.cloudSync.signUp')
  return (
    <>
      <div className="flex gap-1 rounded-md bg-muted p-1 text-sm">
        <button type="button" onClick={() => s.setMode('login')} className={modeClass('login')}>
          {t('settingsView.cloudSync.logIn')}
        </button>
        <button type="button" onClick={() => s.setMode('signup')} className={modeClass('signup')}>
          {t('settingsView.cloudSync.signUp')}
        </button>
      </div>
      <form
        onSubmit={asyncHandler('SettingsView handleCloudLogin', s.mode === 'login' ? s.logIn : s.signUp)}
        className="flex flex-col gap-3"
      >
        <Label className="flex flex-col items-start gap-1.5">
          {t('settingsView.cloudSync.email')}
          <Input type="email" value={s.email} onChange={(e) => s.setEmail(e.target.value)} required />
        </Label>
        <Label className="flex flex-col items-start gap-1.5">
          {t('settingsView.cloudSync.password')}
          <Input
            type="password"
            value={s.password}
            onChange={(e) => s.setPassword(e.target.value)}
            minLength={s.mode === 'signup' ? 12 : undefined}
            required
          />
        </Label>
        {s.mode === 'signup' && (
          <>
            <p className="text-xs text-muted-foreground">{t('settingsView.cloudSync.atLeast12Chars')}</p>
            <Label className="flex flex-col items-start gap-1.5">
              {t('settingsView.cloudSync.inviteCode')}
              <Input
                type="password"
                value={s.inviteCode}
                onChange={(e) => s.setInviteCode(e.target.value)}
                required
              />
            </Label>
            <p className="text-xs text-muted-foreground">{t('settingsView.cloudSync.signupHint')}</p>
          </>
        )}
        <Button type="submit" variant="outline" size="sm" className="w-fit" disabled={s.submitting}>
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
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>{t('settingsView.cloudSync.cardTitle')}</CardTitle>
        <CardDescription>{t('settingsView.cloudSync.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {props.sync.status.loggedIn ? <CloudAccount sync={props.sync} /> : <CloudSignIn sync={props.sync} />}
      </CardContent>
    </Card>
  )
}
