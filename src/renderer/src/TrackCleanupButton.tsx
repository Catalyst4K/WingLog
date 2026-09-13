import { useState } from 'react'
import { Wrench } from 'lucide-react'
import { toast } from 'sonner'
import type { TrackPoint } from '@shared/ipc'
import { Button } from '@/components/ui/button'

/**
 * Logbook's manual "Clean up track" action (flightdeck-backend's docs/plans/done/
 * resume-track-cleanup.md) — re-runs the same cleanup pass TrackingController already
 * runs automatically (live, and once more at flight completion), on demand for a flight
 * with no active recorder at all: one completed before Phase 2 existed, or the rare case
 * the live check missed something. Split out of LogbookView's FlightDetail (rather than
 * inlined there) the same way GsxInvoicesCard is, so it's directly testable without
 * mounting FlightDetail's FlightMap.
 */
export function TrackCleanupButton(props: {
  flightId: number
  /** Only worth showing for a flight that actually resumed at least once — resumeSegment
   *  only ever changes via a real resume() or a cleanup pass finding a standalone
   *  mid-flight teleport, so a flight that never did either has nothing this could find. */
  hadResume: boolean
  onCleaned: (points: TrackPoint[]) => void
}): React.JSX.Element | null {
  const [cleaningUp, setCleaningUp] = useState(false)

  if (!props.hadResume) return null

  async function handleCleanupTrack(): Promise<void> {
    setCleaningUp(true)
    try {
      const result = await window.winglog.trackPointCleanup(props.flightId)
      if (result.excludedCount === 0 && result.resegmentedCount === 0) {
        toast.success('Nothing to clean up — this track already looks right.')
        return
      }
      props.onCleaned(await window.winglog.trackPointList(props.flightId))
      const parts: string[] = []
      if (result.excludedCount > 0) {
        parts.push(`${result.excludedCount} junk point${result.excludedCount === 1 ? '' : 's'} excluded`)
      }
      if (result.resegmentedCount > 0) {
        parts.push(`${result.resegmentedCount} point${result.resegmentedCount === 1 ? '' : 's'} re-segmented`)
      }
      toast.success(`Track cleaned up: ${parts.join(', ')}.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCleaningUp(false)
    }
  }

  return (
    <Button type="button" variant="ghost" size="sm" onClick={handleCleanupTrack} disabled={cleaningUp}>
      <Wrench />
      {cleaningUp ? 'Cleaning up…' : 'Clean up track'}
    </Button>
  )
}
