/**
 * What navigation data the sim has, against the AIRAC calendar and against the plan being flown (winglog-backend
 * docs/plans/navdata-cycle-check.md). Main reads it from disk; the sim's own data states no cycle, so for it there is nothing to say.
 */
import { useTranslation } from 'react-i18next'
import type { NavdataStatus } from '@shared/ipc'
import { navdataWarning, useNavdataStatus } from './navdata-status'
import { SettingsCard } from '../settings/ui/SettingsCard'

/**
 * A note where procedures are chosen, only when the sim's data is behind or does not match the plan: nothing for current data, and
 * nothing for the sim's own data.
 *
 * @param props The cycle the plan was made with, when there is a plan.
 * @returns The element, or nothing.
 */
export function NavdataCycleNote(props: { planAirac?: string | null }): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useNavdataStatus()
  const warning = status ? navdataWarning(status, props.planAirac) : null
  if (!status || !warning) return null
  return (
    <p
      role="status"
      className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground"
    >
      {warning === 'behind'
        ? t('navdataCycle.behind', { cycle: status.cycle, current: status.calendarCycle })
        : t('navdataCycle.planMismatch', { plan: props.planAirac, sim: status.cycle })}
    </p>
  )
}

/**
 * @param status What the sim has.
 * @param t The translation function.
 * @returns The one line that says it.
 */
function statusLine(
  status: NavdataStatus,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (status.source === 'default') return t('navdataCycle.simOwn', { current: status.calendarCycle })
  const values = { cycle: status.cycle, revision: status.revision, validTo: status.validTo }
  return status.validTo ? t('navdataCycle.navigraphValid', values) : t('navdataCycle.navigraph', values)
}

/**
 * Settings: which navigation data the sim has, always, for a pilot who wants to see what WingLog goes by.
 *
 * @returns The card.
 */
export function NavdataCard(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useNavdataStatus()
  return (
    <SettingsCard title={t('navdataCycle.cardTitle')} description={t('navdataCycle.cardDescription')}>
      {status && (
        <div className="flex flex-col gap-1 text-sm">
          <span>{statusLine(status, t)}</span>
          {status.state === 'current' && (
            <span className="text-muted-foreground">
              {t('navdataCycle.statusCurrent', { current: status.calendarCycle })}
            </span>
          )}
          {status.state === 'behind' && (
            <span className="text-amber-600 dark:text-amber-500">
              {t('navdataCycle.behind', { cycle: status.cycle, current: status.calendarCycle })}
            </span>
          )}
        </div>
      )}
    </SettingsCard>
  )
}
