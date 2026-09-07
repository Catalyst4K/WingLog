import { useState } from 'react'

/**
 * Real-world livery photo thumbnail (docs/plans/fleet-redesign.md #3). Deliberately just
 * the thumbnail, not a link to a larger version — adsbdb's full-size `url_photo` field
 * was spot-checked live against two real registrations and 404s consistently, so there's
 * no reliable "view larger" URL to offer (docs/decisions.md, 2026-09-07). Credits
 * airport-data.com rather than an individual photographer — adsbdb doesn't return one.
 * A failed load (photo removed/replaced since lookup, or a fictional/GA registration with
 * none to begin with) just hides the whole figure rather than a broken-image icon.
 */
export function AircraftPhoto(props: { thumbnailUrl: string | null }): React.JSX.Element | null {
  // Tracks the URL that failed, not a plain boolean, so switching to a different
  // aircraft's (different) URL naturally resets this without an effect.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  if (!props.thumbnailUrl || props.thumbnailUrl === failedUrl) return null

  return (
    <figure className="flex w-fit flex-col items-start gap-1">
      <img
        src={props.thumbnailUrl}
        alt=""
        className="max-h-40 rounded-md border border-border object-cover"
        onError={() => setFailedUrl(props.thumbnailUrl)}
      />
      <figcaption className="text-xs text-muted-foreground">Photo via airport-data.com</figcaption>
    </figure>
  )
}
