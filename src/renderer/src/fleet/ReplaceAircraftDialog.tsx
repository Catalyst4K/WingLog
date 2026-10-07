/** The dialog that replaces a fleet aircraft with another and carries its history over. */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Aircraft } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { asyncHandler, runAsync } from '../report-error'

/**
 * A livery/registration change on an airframe still being flown (docs/plans/
 * aircraft-replacement.md) — picks an existing, active fleet aircraft to take over this
 * one's flight history. The target list deliberately excludes already-retired aircraft:
 * chaining a replacement onto one that's already been superseded would need its own
 * "walk the chain" handling this plan doesn't build, and in practice a target is always
 * still active at the moment a replace happens (it might get retired itself later, via a
 * separate replace).
 *
 * @param props The aircraft, the candidates to replace it with, whether it's open, and the handlers.
 * @returns The element.
 */
export function ReplaceAircraftDialog(props: {
  aircraft: Aircraft
  candidates: Aircraft[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (replacementId: number) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [targetId, setTargetId] = useState<number | null>(null)
  const [flightCount, setFlightCount] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // The parent only ever mounts this component while a replace is in progress (see
  // FleetView's `{replaceTarget && <ReplaceAircraftDialog ... />}`), so a fresh mount
  // already means a fresh target/flightCount — no need to reset them on `open` here, just
  // fetch once for whichever aircraft this instance was mounted for.
  useEffect(() => {
    runAsync(
      'FleetView window.winglog',
      window.winglog
        .flightList()
        .then((flights) => setFlightCount(flights.filter((f) => f.aircraftId === props.aircraft.id).length))
    )
  }, [props.aircraft.id])

  const target = props.candidates.find((c) => c.id === targetId) ?? null

  async function handleConfirm(): Promise<void> {
    /* v8 ignore start -- defensive only: the Replace button is disabled whenever `!target`,
     * so this can't fire from a real click. */
    if (!target) return
    /* v8 ignore stop */
    setSubmitting(true)
    try {
      await props.onConfirm(target.id)
      props.onOpenChange(false)
    } catch {
      // The parent already surfaces the failure via toast; swallow it here so it doesn't
      // become an unhandled rejection from this onClick handler, and leave the dialog open.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('fleetView.replaceDialog.title', { registration: props.aircraft.registration })}
          </DialogTitle>
          <DialogDescription>{t('fleetView.replaceDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Label className="flex flex-col items-start gap-1.5">
            {t('fleetView.replaceDialog.replacementAircraft')}
            <Select
              value={targetId != null ? String(targetId) : undefined}
              onValueChange={(v) => setTargetId(Number(v))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('fleetView.replaceDialog.selectPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {props.candidates.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.registration} — {c.icaoType}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          {target && (
            <p className="text-sm text-muted-foreground">
              {t('fleetView.replaceDialog.moveSummary', {
                flightsWillMove:
                  flightCount === null
                    ? t('fleetView.replaceDialog.checkingFlightHistory')
                    : t('fleetView.replaceDialog.flightsWillMove', { count: flightCount }),
                from: props.aircraft.registration,
                to: target.registration
              })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            {t('fleetView.replaceDialog.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={asyncHandler('FleetView handleConfirm', handleConfirm)}
            disabled={!target || submitting}
          >
            {submitting ? t('fleetView.replaceDialog.replacing') : t('fleetView.replaceDialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
