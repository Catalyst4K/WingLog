import { useState } from 'react'
import { Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
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
 *
 * Always shown, not gated on `resumeSegment > 0` (an earlier version was) — Rule 2 (the
 * physically-impossible-jump test, resume-cleanup.ts) runs unconditionally and can find
 * real junk on a flight where `resumeSegment` never changed at all, most notably any
 * flight recorded before Phase 1 existed (confirmed live 2026-09-13 against a real flight,
 * CPA319/#191: `resumeSegment` was 0 throughout, yet the cleanup pass still found and
 * fixed its real restore-teleport). `applyTrackCleanup` already no-ops cheaply when
 * there's nothing to find, so showing this unconditionally costs nothing on a clean flight.
 */
export function TrackCleanupButton(props: {
  flightId: number
  onCleaned: (points: TrackPoint[]) => void
}): React.JSX.Element {
  const [cleaningUp, setCleaningUp] = useState(false)
  const { t } = useTranslation()

  async function handleCleanupTrack(): Promise<void> {
    setCleaningUp(true)
    try {
      const result = await window.winglog.trackPointCleanup(props.flightId)
      if (result.excludedCount === 0 && result.resegmentedCount === 0) {
        toast.success(t('trackCleanupButton.nothingToCleanUp'))
        return
      }
      props.onCleaned(await window.winglog.trackPointList(props.flightId))
      const parts: string[] = []
      if (result.excludedCount > 0) {
        parts.push(t('trackCleanupButton.excludedCount', { count: result.excludedCount }))
      }
      if (result.resegmentedCount > 0) {
        parts.push(t('trackCleanupButton.resegmentedCount', { count: result.resegmentedCount }))
      }
      toast.success(t('trackCleanupButton.cleanedUp', { parts: parts.join(', ') }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCleaningUp(false)
    }
  }

  return (
    <Button type="button" variant="ghost" size="sm" onClick={handleCleanupTrack} disabled={cleaningUp}>
      <Wrench />
      {cleaningUp ? t('trackCleanupButton.cleaningUp') : t('trackCleanupButton.button')}
    </Button>
  )
}
