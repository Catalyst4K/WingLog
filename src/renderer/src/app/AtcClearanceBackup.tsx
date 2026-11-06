/**
 * The procedure-update question, shared by its pop-up and by its backup (winglog-backend docs/plans/v2-design.md, Part 4): left unanswered
 * for a minute the pop-up closes, and the same question waits as a line under the latest instruction on the BeyondATC page, with the same
 * two buttons, until it is answered or a newer clearance replaces it.
 */

import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProcedureSelection } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import type { PendingAtcClearance } from './atc-clearance'
import { AtcClearanceBackupContext } from './atc-clearance-backup-context'

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
 * Each changed field of a clearance, from what is selected to what ATC gave.
 *
 * @param props The clearance and the current selection.
 * @returns The element.
 */
export function ClearanceChanges(props: {
  clearance: PendingAtcClearance
  selection: ProcedureSelection
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {Object.entries(props.clearance.fields).map(([key, value]) => (
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
  )
}

/**
 * The backup line for the BeyondATC page, under the latest instruction.
 *
 * @returns The question with its two buttons, or nothing when no clearance is waiting.
 */
export function AtcClearanceBackupLine(): React.JSX.Element | null {
  const { t } = useTranslation()
  const backup = useContext(AtcClearanceBackupContext)
  if (!backup) return null
  return (
    <div
      role="group"
      aria-label={t('app.atcClearancePrompt.title')}
      className="flex flex-col gap-2 border-t border-border pt-2"
    >
      <p className="text-sm font-medium text-foreground">{t('app.atcClearancePrompt.title')}</p>
      <ClearanceChanges clearance={backup.clearance} selection={backup.selection} />
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={backup.onDismiss}>
          {t('app.atcClearancePrompt.dismiss')}
        </Button>
        <Button type="button" size="sm" onClick={backup.onAccept}>
          {t('app.atcClearancePrompt.update')}
        </Button>
      </div>
    </div>
  )
}
