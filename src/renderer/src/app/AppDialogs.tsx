/**
 * The app-wide prompts that can appear over any tab: an unfinished flight from a previous run,
 * an important GSX menu, and a BeyondATC clearance.
 */

import { winglogApi } from '../data/winglog-api'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { Flight, GsxRemoteMenuState, ProcedureSelection } from '@shared/ipc'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { flightLabel } from '../flight-label'
import { asyncHandler, runAsync } from '../report-error'
import type { PendingAtcClearance } from './atc-clearance'

/** Maps a parsed clearance's ProcedureSelection field name to its existing ProcedureSelector
 *  label key — reused rather than duplicated, same fields, same meaning. */
const ATC_CLEARANCE_FIELD_LABEL_KEYS: Partial<Record<keyof ProcedureSelection, string>> = {
  departureRunway: 'procedureSelector.departureRunway',
  sidIdent: 'procedureSelector.sid',
  starIdent: 'procedureSelector.star',
  approachIdent: 'procedureSelector.approach',
  approachTransition: 'procedureSelector.approachTransition'
}

/**
 * The resume/discard prompt covers two different situations under one flight row — a
 * genuinely 'active' one (WingLog quit or crashed mid-track, TrackingController's
 * in-memory phase-detection state was lost with it) and a merely 'planned' one (Fly was
 * pressed, but tracking never actually started before WingLog closed — nothing crashed,
 * there's just an unfinished plan). Same two choices either way (keep it or discard/delete
 * it), but the wording needs to say which one it actually is, not always claim tracking
 * was interrupted when it may never have started.
 *
 * @param flight The unfinished flight.
 * @param t The translation function.
 * @returns The dialog's title, description and confirm label.
 */
function orphanedFlightCopy(
  flight: Flight,
  t: TFunction
): { title: string; description: string; confirmLabel: string } {
  const label = flightLabel(flight)
  return flight.status === 'active'
    ? {
        title: t('app.orphanedFlight.resumeTitle'),
        description: t('app.orphanedFlight.resumeDescription', { label }),
        confirmLabel: t('app.orphanedFlight.resumeConfirm')
      }
    : {
        title: t('app.orphanedFlight.continueTitle'),
        description: t('app.orphanedFlight.continueDescription', { label }),
        confirmLabel: t('app.orphanedFlight.continueConfirm')
      }
}

/**
 * Asks whether to resume (or continue) a flight a previous run left unfinished, or discard it.
 *
 * @param props The flight (null when there's none), and the close, resume and discard handlers.
 * @returns The element.
 */
export function OrphanedFlightDialog(props: {
  flight: Flight | null
  onClose: () => void
  onResume: () => Promise<void>
  onDiscard: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const { flight } = props
  return (
    <AlertDialog open={flight !== null} onOpenChange={(open) => !open && props.onClose()}>
      <AlertDialogContent>
        {flight && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{orphanedFlightCopy(flight, t).title}</AlertDialogTitle>
              <AlertDialogDescription>{orphanedFlightCopy(flight, t).description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={asyncHandler('App handleDiscardOrphaned', props.onDiscard)}>
                {t('app.orphanedFlight.discard')}
              </AlertDialogCancel>
              <AlertDialogAction onClick={asyncHandler('App handleResumeOrphaned', props.onResume)}>
                {orphanedFlightCopy(flight, t).confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * An important GSX menu (pushback direction, fuel amount), shown over whatever tab is open.
 * Picking an entry answers it in the sim; GSX then clears or replaces the menu itself.
 *
 * @param props The menu, whether the prompt is open, and the dismiss handler.
 * @returns The element.
 */
export function ImportantGsxMenuDialog(props: {
  menu: GsxRemoteMenuState | null
  open: boolean
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { menu } = props
  function handlePick(index: number): void {
    runAsync('App gsxRemotePickMenu', winglogApi().gsxRemotePickMenu(index))
    // GSX will clear/replace state.menu itself once the pick is processed — no need to
    // clear the menu here too, and doing so would just make the dialog flash closed then
    // (possibly) reopen for the next patch.
  }
  return (
    <Dialog open={props.open} onOpenChange={(next) => !next && props.onDismiss()}>
      <DialogContent className="sm:max-w-md">
        {menu && (
          <>
            <DialogHeader>
              <DialogTitle>{t('app.gsxImportantPrompt.title')}</DialogTitle>
            </DialogHeader>
            {/* GSX's own text, verbatim — not translated, same convention as
                SimBrief-sourced data (third-party content, not ours to translate). */}
            <p className="text-sm font-medium text-foreground">{menu.title || menu.header}</p>
            <div className="flex flex-col gap-1.5">
              {menu.entries.map((entry, index) => (
                <Button
                  key={`${index}-${entry}`}
                  type="button"
                  variant="outline"
                  disabled={menu.disabled[index] === true}
                  className="h-auto whitespace-normal py-2 text-left justify-start"
                  onClick={() => handlePick(index)}
                >
                  {entry}
                </Button>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * A BeyondATC clearance that differs from the current selection: each changed field, from
 * what's selected to what ATC gave, with Update and Dismiss.
 *
 * @param props The clearance (null when there's none), the current selection, and the handlers.
 * @returns The element.
 */
export function AtcClearanceDialog(props: {
  clearance: PendingAtcClearance | null
  selection: ProcedureSelection
  onAccept: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { clearance } = props
  return (
    <Dialog open={clearance !== null} onOpenChange={(open) => !open && props.onDismiss()}>
      <DialogContent className="sm:max-w-md">
        {clearance && (
          <>
            <DialogHeader>
              <DialogTitle>{t('app.atcClearancePrompt.title')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1.5 text-sm">
              {Object.entries(clearance.fields).map(([key, value]) => (
                <p key={key}>
                  <span className="font-medium text-foreground">
                    {t(ATC_CLEARANCE_FIELD_LABEL_KEYS[key as keyof ProcedureSelection] ?? '')}:{' '}
                  </span>
                  <span className="text-muted-foreground">
                    {props.selection[key as keyof ProcedureSelection] ?? t('procedureSelector.none')}
                  </span>
                  {' → '}
                  <span className="text-foreground">{value ?? t('procedureSelector.none')}</span>
                </p>
              ))}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={props.onDismiss}>
                {t('app.atcClearancePrompt.dismiss')}
              </Button>
              <Button type="button" onClick={props.onAccept}>
                {t('app.atcClearancePrompt.update')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
