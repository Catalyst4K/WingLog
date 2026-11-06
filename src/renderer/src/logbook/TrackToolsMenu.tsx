/** The flight page's "Track tools" menu: keep the capture, clean up the track, fill gaps from the plan, gathered into one button. */

import { Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TrackPoint } from '@shared/ipc'
import type { EstimatedStretch } from '@shared/track-gap-fill'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { KeepCaptureButton } from '../KeepCaptureButton'
import { TrackCleanupButton } from '../TrackCleanupButton'
import { TrackGapFillButton } from '../TrackGapFillButton'

/**
 * One menu in place of three buttons beside View OFP PDF and Delete flight (winglog-backend docs/plans/v2-design.md, "The screens").
 * The three tools are the existing buttons, unchanged, stacked in the menu.
 *
 * @param props The flight, what cleaning the track hands back, and the gap-fill estimate with its change handler.
 * @returns The element.
 */
export function TrackToolsMenu(props: {
  flightId: number
  onCleaned: (points: TrackPoint[]) => void
  estimate: EstimatedStretch[]
  onEstimateChanged: (estimate: EstimatedStretch[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Wrench />
          {t('logbookView.trackTools')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-56 flex-col items-stretch gap-1 p-1.5 *:justify-start">
        <KeepCaptureButton flightId={props.flightId} />
        <TrackCleanupButton flightId={props.flightId} onCleaned={props.onCleaned} />
        <TrackGapFillButton
          flightId={props.flightId}
          estimate={props.estimate}
          onChanged={props.onEstimateChanged}
        />
      </PopoverContent>
    </Popover>
  )
}
