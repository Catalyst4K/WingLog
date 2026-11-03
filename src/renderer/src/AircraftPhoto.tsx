/** An aircraft's photo: the pilot's own, or the real-world one from its registration lookup. */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The picture of an aircraft, large on its detail page or small in the form. It shows the first of these that loads: the pilot's own
 * picture, the lookup's full-size photo, the lookup's thumbnail (about 150 px wide, so only a fallback). A photo that fails to load
 * (removed or replaced since the lookup, or a fictional or GA registration with none) is skipped; with nothing left the whole figure is
 * hidden rather than showing a broken-image icon. Only a looked-up photo is credited, to airport-data.com: adsbdb names no photographer.
 * Large is edge to edge across the top of a Card (docs/plans/aircraft-photos.md).
 *
 * @param props The three sources, what the picture is of (alt text; empty for a purely decorative one), and whether it is large.
 * @returns The element, or null when there is nothing to show.
 */
export function AircraftPhoto(props: {
  customPhoto: string | null
  photoUrl: string | null
  thumbnailUrl: string | null
  alt?: string
  variant?: 'large' | 'preview'
}): React.JSX.Element | null {
  // The URLs that failed, not a flag, so switching to a different aircraft's URLs naturally starts afresh without an effect.
  const [failedUrls, setFailedUrls] = useState<string[]>([])
  const { t } = useTranslation()

  const shown = [props.customPhoto, props.photoUrl, props.thumbnailUrl].find(
    (url): url is string => !!url && !failedUrls.includes(url)
  )
  if (!shown) return null

  const isOwn = shown === props.customPhoto
  const credit = isOwn ? null : t('aircraftPhoto.credit')
  const onError = (): void => setFailedUrls((urls) => [...urls, shown])

  if (props.variant === 'preview') {
    return (
      <figure className="flex w-fit flex-col items-start gap-1">
        <img
          src={shown}
          alt={props.alt ?? ''}
          className="max-h-40 rounded-md border border-border object-cover"
          onError={onError}
        />
        {credit && <figcaption className="text-xs text-muted-foreground">{credit}</figcaption>}
      </figure>
    )
  }
  return (
    <figure className="-mt-(--card-spacing) flex flex-col gap-1.5">
      <img src={shown} alt={props.alt ?? ''} className="aspect-[3/2] w-full object-cover" onError={onError} />
      {credit && (
        <figcaption className="px-(--card-spacing) text-xs text-muted-foreground">{credit}</figcaption>
      )}
    </figure>
  )
}
