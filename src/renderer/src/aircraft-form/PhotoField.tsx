/** The aircraft form's photo: a preview, and choosing or removing the pilot's own picture. */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { AircraftPhotoSources } from '@shared/aircraft-photo'
import { AircraftPhoto } from '../AircraftPhoto'
import { winglogApi } from '../data/winglog-api'
import { asyncHandler } from '../report-error'

/**
 * The photo row of the aircraft form. The main process opens the file dialog and shrinks the picture; this only holds what comes
 * back until the aircraft is saved. Removing the pilot's own picture brings back the looked-up photo, which it never replaced.
 *
 * @param props The photo sources the form holds, and the handler for a changed own picture (null removes it).
 * @returns The element.
 */
export function PhotoField(props: {
  sources: AircraftPhotoSources
  onChange: (customPhoto: string | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [isChoosing, setIsChoosing] = useState(false)

  async function handleChoose(): Promise<void> {
    setIsChoosing(true)
    setError(null)
    try {
      const picked = await winglogApi().aircraftPickPhoto()
      if (picked === null) return
      if ('error' in picked) setError(picked.error)
      else props.onChange(picked.dataUrl)
    } finally {
      setIsChoosing(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t('aircraftForm.photo.label')}</Label>
      <AircraftPhoto sources={props.sources} variant="preview" />
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isChoosing}
          onClick={asyncHandler('AircraftForm photo choose', handleChoose)}
        >
          {props.sources.customPhoto ? t('aircraftForm.photo.replace') : t('aircraftForm.photo.choose')}
        </Button>
        {props.sources.customPhoto && (
          <Button type="button" variant="ghost" size="sm" onClick={() => props.onChange(null)}>
            {t('aircraftForm.photo.remove')}
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{t('aircraftForm.photo.hint')}</p>
      )}
    </div>
  )
}
