/** A label and value pair in a Logbook detail card. */

import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Two label/value columns whose tracks may shrink below their content's width
 *  (`minmax(0, 1fr)`, not the bare `1fr` of `grid-cols-2`, which can't) - otherwise a long
 *  label or mono-font value overflows into its neighbour when the window narrows (beta
 *  feedback 2026-09-18). Paired with DetailField's `min-w-0 break-words`. */
export const DETAIL_GRID_CLASS = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm'

/**
 * One label and value pair in a detail list. `warn` shows a small warning icon next to the
 * label when this field's own score-breakdown category came in below
 * LandingScoreBreakdownDialog's bad threshold — a nudge to open the breakdown rather than
 * repeating the deduction number here too.
 *
 * @param props The label, the value, whether to warn, and a class for the value.
 * @returns The element.
 */
export function DetailField(props: {
  label: string
  value: React.ReactNode
  warn?: boolean
  /** Merged onto the value <dd> — e.g. a slightly larger size for the one field (Landing
   *  score) that should stand out from the rest of the list. */
  valueClassName?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <dt className="flex min-w-0 items-center gap-1.5 break-words text-muted-foreground">
        {props.label}
        {props.warn && (
          <TriangleAlert className="size-3.5 text-destructive" aria-label={t('logbookView.belowAverage')} />
        )}
      </dt>
      <dd className={cn('min-w-0 break-words text-foreground', props.valueClassName)}>{props.value}</dd>
    </>
  )
}
