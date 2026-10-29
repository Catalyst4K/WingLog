/**
 * Settings → 3rd party → Online network: whether the app keeps the ATC coverage areas up to date by itself, which releases are in use and
 * when GitHub was last asked, and Check now (winglog-backend docs/plans/atc-areas-auto-update.md).
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AtcAreasCheck, AtcAreasStatus } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { winglogApi } from '../data/winglog-api'
import { asyncHandler, runAsync } from '../report-error'
import { OnOffControl, SettingRow } from './ui/SettingsCard'

/**
 * @returns The row, or nothing until the status is read.
 */
export function AtcAreasRow(): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<AtcAreasStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<AtcAreasCheck | null>(null)

  useEffect(() => {
    runAsync('AtcAreasRow atcAreasGetStatus', winglogApi().atcAreasGetStatus().then(setStatus))
  }, [])

  if (!status) return null
  const when = status.checkedAt
    ? t('settingsView.onlineNetwork.atcAreasChecked', {
        when: new Date(status.checkedAt).toLocaleDateString(i18n.language, { dateStyle: 'medium' })
      })
    : t('settingsView.onlineNetwork.atcAreasNeverChecked')
  const inUse = t('settingsView.onlineNetwork.atcAreasInUse', {
    vatspy: status.vatspy,
    tracon: status.tracon,
    source:
      status.source === 'downloaded'
        ? t('settingsView.onlineNetwork.atcAreasDownloaded')
        : t('settingsView.onlineNetwork.atcAreasBundled')
  })

  const checkNow = async (): Promise<void> => {
    setChecking(true)
    setResult(null)
    try {
      const outcome = await winglogApi().atcAreasCheckNow()
      setResult(outcome)
      setStatus(outcome.status)
    } finally {
      setChecking(false)
    }
  }

  return (
    <SettingRow
      label={t('settingsView.onlineNetwork.atcAreas')}
      note={`${t('settingsView.onlineNetwork.atcAreasHint')} ${inUse} ${when}`}
    >
      <div className="flex flex-col items-end gap-2">
        <OnOffControl
          label={t('settingsView.onlineNetwork.atcAreas')}
          enabled={status.auto}
          onText={t('settingsView.beyondAtc.on')}
          offText={t('settingsView.beyondAtc.off')}
          onChange={asyncHandler('AtcAreasRow atcAreasSetAuto', async (on: boolean) =>
            setStatus(await winglogApi().atcAreasSetAuto(on))
          )}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={asyncHandler('AtcAreasRow atcAreasCheckNow', checkNow)}
        >
          {checking
            ? t('settingsView.onlineNetwork.atcAreasChecking')
            : t('settingsView.onlineNetwork.atcAreasCheckNow')}
        </Button>
        {result && (
          <span role="status" className="text-xs text-muted-foreground">
            {result.outcome === 'updated'
              ? t('settingsView.onlineNetwork.atcAreasUpdated', {
                  vatspy: result.status.vatspy,
                  tracon: result.status.tracon
                })
              : result.outcome === 'failed'
                ? t('settingsView.onlineNetwork.atcAreasFailed')
                : t('settingsView.onlineNetwork.atcAreasCurrent')}
          </span>
        )}
      </div>
    </SettingRow>
  )
}
