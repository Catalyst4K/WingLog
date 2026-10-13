/** Settings → About's update check card. */

import { winglogApi } from './data/winglog-api'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateSettings, UpdateStatus } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { asyncHandler, runAsync } from './report-error'
import { OnOffControl, SettingRow, SettingsCard } from './settings/ui/SettingsCard'

/**
 * Settings → About: the automatic update check's switch, "Check now", and the last result
 * (winglog-backend's docs/plans/update-check.md).
 *
 * @returns The element.
 */
export function UpdatesCard(): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<UpdateSettings | null>(null)
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    runAsync('UpdatesCard settingsGetUpdates', winglogApi().settingsGetUpdates().then(setSettings))
    runAsync('UpdatesCard updatesGetStatus', winglogApi().updatesGetStatus().then(setStatus))
    return winglogApi().onUpdateStatus(setStatus)
  }, [])

  function setCheckEnabled(checkEnabled: boolean): void {
    setSettings({ checkEnabled })
    runAsync('UpdatesCard settingsSetUpdates', winglogApi().settingsSetUpdates({ checkEnabled }))
  }

  return (
    <SettingsCard title={t('updates.settings.title')} description={t('updates.settings.description')}>
      <SettingRow label={t('updates.settings.autoCheck')}>
        <OnOffControl
          label={t('updates.settings.autoCheck')}
          enabled={settings?.checkEnabled === true}
          disabled={settings === null}
          onText={t('updates.settings.on')}
          offText={t('updates.settings.off')}
          onChange={setCheckEnabled}
        />
      </SettingRow>
      <SettingRow label={status ? statusText(t, status) : ''} labelRole="status">
        {status?.state === 'available' && status.latest && (
          <Button
            type="button"
            size="sm"
            onClick={asyncHandler('UpdatesCard updatesOpenRelease', () => winglogApi().updatesOpenRelease())}
          >
            {t('updates.banner.download')}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={status?.state === 'checking'}
          onClick={asyncHandler('UpdatesCard updatesCheckNow', () => winglogApi().updatesCheckNow())}
        >
          {t('updates.settings.checkNow')}
        </Button>
      </SettingRow>
    </SettingsCard>
  )
}

function statusText(
  t: (key: string, options?: Record<string, string>) => string,
  status: UpdateStatus
): string {
  switch (status.state) {
    case 'checking':
      return t('updates.settings.checking')
    case 'available':
      return t('updates.banner.available', { version: status.latest?.version ?? '' })
    case 'upToDate':
      return t('updates.settings.upToDate', { version: status.currentVersion })
    case 'error':
      return t('updates.settings.error')
    default:
      return ''
  }
}
