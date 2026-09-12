import { Fragment } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import type { LandingDistanceUnit, LandingScoreCategory } from '@shared/ipc'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { describeCategoryTolerance, formatCategoryScore, isCategoryBad } from './landing-score-ui'

/**
 * Logbook's landing-score breakdown popup (docs/decisions.md, 2026-09-12) — lets Callum
 * see exactly which of the score's 7 inputs pulled it down, not just the combined number.
 * Triggered from LandingCard's own "Score breakdown" header button.
 */
export function LandingScoreBreakdownDialog(props: {
  overall: number
  categories: LandingScoreCategory[]
  unit: LandingDistanceUnit
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
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="cursor-pointer text-muted-foreground/60 hover:text-foreground"
                      aria-label={`What's ideal for ${category.label}?`}
                    >
                      <Info className="size-3.5" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent>
                    {describeCategoryTolerance(category.key, category.ideal, category.tolerance, props.unit)}
                  </PopoverContent>
                </Popover>
              </dt>
              <dd
                className={cn(
                  'text-right font-mono tabular-nums',
                  isCategoryBad(category.score) ? 'text-destructive' : 'text-foreground'
                )}
              >
                {formatCategoryScore(category.score)}
                {category.score !== null && <span className="text-muted-foreground"> / 10</span>}
              </dd>
            </Fragment>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
