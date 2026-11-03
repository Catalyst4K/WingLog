/** An aircraft's photo: the pilot's own, or the real-world one from its registration lookup. */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PHOTO_BOX_DEFAULT_RATIO, photoBoxRatio, type AircraftPhotoSources } from '@shared/aircraft-photo'
import { winglogApi } from './data/winglog-api'
import { runAsync } from './report-error'

/**
 * A link to a Planespotters photo's page, as its terms ask of the photo and its credit. It is a plain anchor with its real address; a
 * click opens it in the system browser through the main process, not in this window.
 *
 * @param props The photo's page, the link's class, and what it wraps.
 * @returns The anchor.
 */
function PhotoPageLink(props: {
  pageUrl: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <a
      href={props.pageUrl}
      className={props.className}
      onClick={(event) => {
        event.preventDefault()
        runAsync('AircraftPhoto open photo page', winglogApi().aircraftOpenPhotoPage(props.pageUrl))
      }}
    >
      {props.children}
    </a>
  )
}

/**
 * The picture of an aircraft, large on its detail page or small in the form. It shows the first of its sources that loads: the pilot's
 * own picture, Planespotters' photo, airport-data's full-size photo, airport-data's thumbnail (about 150 px wide, so only a last resort).
 * A photo that fails to load (removed or replaced since the lookup, or a fictional or GA registration with none) is skipped; with
 * nothing left the whole figure is hidden rather than showing a broken-image icon. Each looked-up photo is credited as its source asks:
 * Planespotters by photographer and a link to the photo's page (the image links there too), airport-data by name only, as adsbdb names
 * no photographer. The pilot's own picture has no credit. Large is the full width of a Card, edge to edge across its top, and takes the
 * picture's own shape (clamped, see photoBoxRatio), so a normal photo fills it exactly with nothing cropped and no empty bands; only a
 * very tall or very wide one is shown whole on a neutral band (docs/plans/aircraft-photos.md).
 *
 * @param props The sources, what the picture is of (alt text; empty for a purely decorative one), and whether it is large.
 * @returns The element, or null when there is nothing to show.
 */
export function AircraftPhoto(props: {
  sources: AircraftPhotoSources
  alt?: string
  variant?: 'large' | 'preview'
}): React.JSX.Element | null {
  // The URLs that failed, not a flag, so switching to a different aircraft's URLs naturally starts afresh without an effect.
  const [failedUrls, setFailedUrls] = useState<string[]>([])
  // The shape of the picture being shown, once it has loaded, so the large box can take it; keyed by URL like failedUrls.
  const [shape, setShape] = useState<{ url: string; ratio: number } | null>(null)
  const { t } = useTranslation()
  const { customPhoto, planespotters, photoUrl, thumbnailUrl } = props.sources

  const shown = [customPhoto, planespotters?.photoUrl, photoUrl, thumbnailUrl].find(
    (url): url is string => !!url && !failedUrls.includes(url)
  )
  if (!shown) return null

  const fromPlanespotters = planespotters && shown === planespotters.photoUrl ? planespotters : null
  const credit =
    shown === customPhoto ? null : fromPlanespotters ? (
      <>
        {t('aircraftPhoto.creditPhotographer', { photographer: fromPlanespotters.photographer })}
        {' · '}
        <PhotoPageLink
          pageUrl={fromPlanespotters.pageUrl}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Planespotters.net
        </PhotoPageLink>
      </>
    ) : (
      t('aircraftPhoto.credit')
    )
  const onError = (): void => setFailedUrls((urls) => [...urls, shown])
  const onLoad = (event: React.SyntheticEvent<HTMLImageElement>): void => {
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (naturalWidth > 0 && naturalHeight > 0) setShape({ url: shown, ratio: naturalWidth / naturalHeight })
  }
  const image = (className: string, style?: React.CSSProperties): React.JSX.Element => {
    const img = (
      <img
        src={shown}
        alt={props.alt ?? ''}
        className={className}
        style={style}
        onError={onError}
        onLoad={onLoad}
      />
    )
    return fromPlanespotters ? (
      <PhotoPageLink pageUrl={fromPlanespotters.pageUrl} className="block">
        {img}
      </PhotoPageLink>
    ) : (
      img
    )
  }

  if (props.variant === 'preview') {
    return (
      <figure className="flex w-fit flex-col items-start gap-1">
        {image('max-h-40 rounded-md border border-border object-cover')}
        {credit && <figcaption className="text-xs text-muted-foreground">{credit}</figcaption>}
      </figure>
    )
  }
  return (
    <figure className="-mt-(--card-spacing) flex flex-col gap-1.5">
      {image('w-full bg-muted object-contain', {
        aspectRatio: shape?.url === shown ? photoBoxRatio(shape.ratio) : PHOTO_BOX_DEFAULT_RATIO
      })}
      {credit && (
        <figcaption className="px-(--card-spacing) text-xs text-muted-foreground">{credit}</figcaption>
      )}
    </figure>
  )
}
