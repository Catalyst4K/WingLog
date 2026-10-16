/** Logbook's "Fill gaps from the flight plan" button. */

import { winglogApi } from './data/winglog-api'
import { useState } from 'react'
import { Route } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { EstimatedStretch } from '@shared/track-gap-fill'
import { Button } from '@/components/ui/button'
import { asyncHandler } from './report-error'

/**
 * Logbook's "Fill gaps from the flight plan" (winglog-backend's docs/plans/track-gap-fill.md): after a flight whose recording
 * stopped for a while (the app closed, a full disk), draws the missing stretch along the flight's OFP route, dashed and apart from
 * the recorded line, and keeps it with the flight. With stretches already there the same button takes them away again. The
 * recorded points are never touched either way.
 *
 * @param props The flight, the stretches it has now, and what to do when they change.
 * @returns The element.
 */
export function TrackGapFillButton(props: {
  flightId: number
  estimate: EstimatedStretch[]
  onChanged: (estimate: EstimatedStretch[]) => void
}): React.JSX.Element {
  const [working, setWorking] = useState(false)
  const { t } = useTranslation()
  const hasEstimate = props.estimate.length > 0

  /**
   * Fills the gaps, or removes the earlier fill, and says what happened.
   */
  async function handleClick(): Promise<void> {
    setWorking(true)
    try {
      if (hasEstimate) {
        await winglogApi().trackEstimateClear(props.flightId)
        props.onChanged([])
        toast.success(t('trackGapFillButton.removed'))
        return
      }
      const result = await winglogApi().trackEstimateFill(props.flightId)
      if (result.outcome === 'noRoute') {
        toast.info(t('trackGapFillButton.noRoute'))
        return
      }
      if (result.outcome === 'noGaps') {
        toast.info(t('trackGapFillButton.noGaps'))
        return
      }
      props.onChanged(await winglogApi().trackEstimateGet(props.flightId))
      toast.success(t('trackGapFillButton.filled', { count: result.count, nm: Math.round(result.lengthNm) }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={asyncHandler('TrackGapFillButton handleClick', handleClick)}
      disabled={working}
    >
      <Route />
      {hasEstimate ? t('trackGapFillButton.remove') : t('trackGapFillButton.button')}
    </Button>
  )
}
