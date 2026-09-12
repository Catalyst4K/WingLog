import { Fragment } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { LandingScoreCategory } from '@shared/ipc'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { categoryMaxPoints, formatDeduction, isCategoryBad } from './landing-score-ui'

/**
 * Logbook's landing-score breakdown popup (docs/decisions.md, 2026-09-12) — lets Callum
 * see exactly which of the score's 7 inputs pulled it down, not just the combined number.
 * Triggered from LandingCard, either its own "View breakdown" control or a warning icon on
 * a specific bad field — same dialog either way, so there's one place this ever renders.
 */
export function LandingScoreBreakdownDialog(props: {
  overall: number
  categories: LandingScoreCategory[]
  trigger: React.ReactNode
}): React.JSX.Element {
  return (
    <Dialog>
      <DialogTrigger asChild>{props.trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Landing score breakdown — {props.overall}/100</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
          {props.categories.map((category) => (
            <Fragment key={category.key}>
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                {isCategoryBad(category.score) && (
                  <TriangleAlert className="size-3.5 text-destructive" aria-hidden="true" />
                )}
                {category.label}
              </dt>
              <dd
                className={cn(
                  'text-right font-mono tabular-nums',
                  isCategoryBad(category.score) ? 'text-destructive' : 'text-foreground'
                )}
              >
                {formatDeduction(category.score, category.weight)}
                {category.score !== null && (
                  <span className="text-muted-foreground"> / {categoryMaxPoints(category.weight).toFixed(1)}</span>
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
