import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, X } from 'lucide-react'
import type { UpdateStatus } from '@shared/ipc'
import { Button } from '@/components/ui/button'

/**
 * "WingLog 1.4.1 is available" across the top of the app (flightdeck-backend's
 * docs/plans/update-check.md, Part A). The check itself runs in main; this only shows its
 * result. Hidden while the aircraft is airborne, so it never interrupts a flight, and for a
 * version the user skipped. Dismissing it hides it for this session only.
 */
export function UpdateBanner(props: { airborne: boolean }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const [showNotes, setShowNotes] = useState(false)

  useEffect(() => {
    window.winglog.updatesGetStatus().then(setStatus)
    return window.winglog.onUpdateStatus(setStatus)
  }, [])

  const latest = status?.state === 'available' ? status.latest : null
  if (!latest || props.airborne || latest.version === status?.skippedVersion || latest.version === dismissedVersion) {
    return null
  }

  return (
    <section
      aria-label={t('updates.banner.label')}
      className="flex flex-col gap-2 border-b border-border bg-primary/10 px-6 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{t('updates.banner.available', { version: latest.version })}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {latest.notes && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowNotes((v) => !v)} aria-expanded={showNotes}>
              {showNotes ? t('updates.banner.hideNotes') : t('updates.banner.whatsNew')}
            </Button>
          )}
          <Button type="button" size="sm" onClick={() => window.winglog.updatesOpenRelease()}>
            <Download aria-hidden="true" />
            {t('updates.banner.download')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => window.winglog.updatesSkipVersion(latest.version)}>
            {t('updates.banner.skip')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('updates.banner.dismiss')}
            title={t('updates.banner.dismiss')}
            onClick={() => setDismissedVersion(latest.version)}
          >
            <X />
          </Button>
        </div>
      </div>
      {showNotes && (
        // Release notes are third-party text: shown as plain text, never parsed as HTML.
        <pre className="max-h-48 overflow-auto font-sans text-xs whitespace-pre-wrap text-muted-foreground">{latest.notes}</pre>
      )}
    </section>
  )
}
