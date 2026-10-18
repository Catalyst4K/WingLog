/** The buttons that take an update from "available" to installed, shared by the banner and Settings. */

import { winglogApi } from './data/winglog-api'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, RefreshCw } from 'lucide-react'
import type { UpdateStatus } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { runAsync } from './report-error'

/**
 * "Download and install", then "Restart to update" (winglog-backend's
 * docs/plans/one-click-update.md). A build that can't install itself keeps the plain
 * "Download", which opens the release page. Main decides whether a restart may happen; if a
 * flight is being tracked it says so and nothing closes.
 *
 * @param props The status to act on.
 * @returns The button, with a short note beside it when something needs saying.
 */
export function UpdateActions(props: { status: UpdateStatus }): React.JSX.Element {
  const { t } = useTranslation()
  const [flightActive, setFlightActive] = useState(false)
  const { install } = props.status

  if (!install.supported) {
    return (
      <Button
        type="button"
        size="sm"
        onClick={() => runAsync('UpdateActions updatesOpenRelease', winglogApi().updatesOpenRelease())}
      >
        <Download aria-hidden="true" />
        {t('updates.banner.download')}
      </Button>
    )
  }

  if (install.phase === 'downloading') {
    return (
      <Button type="button" size="sm" disabled>
        <Download aria-hidden="true" />
        {t('updates.install.downloading', { percent: install.percent })}
      </Button>
    )
  }

  if (install.phase === 'ready') {
    return (
      <>
        {flightActive && (
          <span role="status" className="text-xs text-muted-foreground">
            {t('updates.install.flightActive')}
          </span>
        )}
        <Button
          type="button"
          size="sm"
          onClick={() =>
            runAsync(
              'UpdateActions updatesInstall',
              winglogApi()
                .updatesInstall()
                .then((outcome) => setFlightActive(outcome === 'flightActive'))
            )
          }
        >
          <RefreshCw aria-hidden="true" />
          {t('updates.install.restart')}
        </Button>
      </>
    )
  }

  return (
    <>
      {install.phase === 'error' && (
        <span role="status" className="text-xs text-muted-foreground">
          {t('updates.install.failed')}
        </span>
      )}
      {install.phase === 'error' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => runAsync('UpdateActions updatesOpenRelease', winglogApi().updatesOpenRelease())}
        >
          {t('updates.install.releasePage')}
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        onClick={() => runAsync('UpdateActions updatesDownload', winglogApi().updatesDownload())}
      >
        <Download aria-hidden="true" />
        {install.phase === 'error' ? t('updates.install.retry') : t('updates.install.downloadAndInstall')}
      </Button>
    </>
  )
}
