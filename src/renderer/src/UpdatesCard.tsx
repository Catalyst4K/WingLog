/** Settings → About's update check card. */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateSettings, UpdateStatus } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { asyncHandler, runAsync } from './report-error'

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
    runAsync('UpdatesCard settingsGetUpdates', window.winglog.settingsGetUpdates().then(setSettings))
    runAsync('UpdatesCard updatesGetStatus', window.winglog.updatesGetStatus().then(setStatus))
    return window.winglog.onUpdateStatus(setStatus)
  }, [])

  function setCheckEnabled(checkEnabled: boolean): void {
    setSettings({ checkEnabled })
    runAsync('UpdatesCard settingsSetUpdates', window.winglog.settingsSetUpdates({ checkEnabled }))
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{t('updates.settings.title')}</CardTitle>
        <CardDescription>{t('updates.settings.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted-foreground">{t('updates.settings.autoCheck')}</span>
          <div className="flex gap-1.5" role="group" aria-label={t('updates.settings.autoCheck')}>
            {[true, false].map((value) => (
              <Button
                key={String(value)}
                type="button"
                size="sm"
                variant={settings?.checkEnabled === value ? 'default' : 'outline'}
                aria-pressed={settings?.checkEnabled === value}
                disabled={settings === null}
                onClick={() => setCheckEnabled(value)}
              >
                {value ? t('updates.settings.on') : t('updates.settings.off')}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={status?.state === 'checking'}
            onClick={asyncHandler('UpdatesCard updatesCheckNow', () => window.winglog.updatesCheckNow())}
          >
            {t('updates.settings.checkNow')}
          </Button>
          <p role="status" className="text-xs text-muted-foreground">
            {status && statusText(t, status)}
          </p>
        </div>
        {status?.state === 'available' && status.latest && (
          <div>
            <Button
              type="button"
              size="sm"
              onClick={asyncHandler('UpdatesCard updatesOpenRelease', () =>
                window.winglog.updatesOpenRelease()
              )}
            >
              {t('updates.banner.download')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
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
