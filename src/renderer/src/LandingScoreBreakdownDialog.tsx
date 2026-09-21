import { Fragment } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LandingDistanceUnit, LandingScoreCategory } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { describeCategoryTolerance, formatCategoryScore, isCategoryBad } from './landing-score-ui'

// Applied once per category in `dangerousCategories` (shared/landing-score.ts's
// DANGEROUS_EXCEEDANCE_DEDUCTION) — duplicated here only for the banner's own wording, not
// re-derived from `overall` (which the dialog never gets the pre-deduction value for).
const DANGEROUS_EXCEEDANCE_DEDUCTION = 20

/**
 * Logbook's landing-score breakdown popup (docs/decisions.md, 2026-09-12) — lets Callum
 * see exactly which of the score's 7 inputs pulled it down, not just the combined number.
 * Triggered from LandingCard's own "Score breakdown" header button.
 *
 * First component ported to the app-languages i18n layer (docs/plans/v1-2.md Part 3,
 * "phased view by view, one reviewable commit each") — proof of the pipeline, not a claim
 * that this view is fully translated. `category.label` is still an English literal sourced
 * from the main process (landing-score-resolver.ts's CATEGORY_LABELS) and formatCategoryScore's
 * "N/A" is still a hardcoded English literal too — both real, known gaps for a later phase,
 * not fixed here.
 */
export function LandingScoreBreakdownDialog(props: {
  overall: number
  categories: LandingScoreCategory[]
  unit: LandingDistanceUnit
  trigger: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const dangerousCategories = props.categories.filter((category) => category.dangerous)
  return (
    <Dialog>
      <DialogTrigger asChild>{props.trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('landingScoreBreakdown.title', { score: props.overall })}</DialogTitle>
        </DialogHeader>
        {dangerousCategories.length > 0 && (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            {t('landingScoreBreakdown.dangerousBanner', {
              list: dangerousCategories.map((category) => category.label).join(', '),
              penalty: dangerousCategories.length * DANGEROUS_EXCEEDANCE_DEDUCTION
            })}
          </p>
        )}
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
          {props.categories.map((category) => (
            <Fragment key={category.key}>
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                {isCategoryBad(category.score) && (
                  <TriangleAlert className="size-3.5 text-destructive" aria-hidden="true" />
                )}
                {category.label}
                {category.dangerous && (
                  <Badge variant="destructive">{t('landingScoreBreakdown.dangerousBadge')}</Badge>
                )}
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="cursor-pointer text-muted-foreground/60 hover:text-foreground"
                      aria-label={t('landingScoreBreakdown.whatsIdealFor', { label: category.label })}
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
                {category.score !== null && (
                  <span className="text-muted-foreground">{t('landingScoreBreakdown.outOfTen')}</span>
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
