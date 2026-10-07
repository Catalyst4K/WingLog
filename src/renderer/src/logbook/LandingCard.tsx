/** The landing card on a flight's detail page. */

import { winglogApi } from '../data/winglog-api'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LandingDistanceUnit, LandingScoreCategoryKey, LandingWithDetails } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { landingLabels } from '../landing-labels'
import { LandingBadge } from '../LandingBadge'
import { LandingScoreBadge } from '../LandingScoreBadge'
import { LandingScoreBreakdownDialog } from '../LandingScoreBreakdownDialog'
import { isCategoryBad } from '../landing-score-ui'
import { TouchdownDiagram } from '../TouchdownDiagram'
import { formatCentrelineOffset, formatPitchDeg, formatRunwayDistance, msToFpm, msToKt } from '../units'
import { runAsync } from '../report-error'
import { DETAIL_GRID_CLASS, DetailField } from './DetailField'

/** The fuller companion to Fleet's per-aircraft history (docs/decisions.md,
 *  landing-analysis entry) — a Logbook entry is already the place for full flight detail,
 *  so this shows more of the record than Fleet's compact row does. Same conditional-
 *  rendering pattern the fuel chart above already uses: render nothing when there's no
 *  landing to show (the common case for any flight tracked before this feature existed),
 *  not an empty card. */
// Above this many landings, per-landing tabs across the card header would shrink to
// unreadable — a Select takes over instead (Callum's design, 2026-09-16). 4 is the plan
// doc's own recommendation from the card's layout, not a measured breakpoint — worth a
// look at the real card at the narrowest supported width if it ever looks cramped.
const LANDING_TAB_THRESHOLD = 4

/** Labels for the tabs/select switcher: the airfield and which attempt it was *at that
 *  airfield* ("VHHX 1", "VHHH 1", then "VHHH 2") — not a runway and a clock time, which read as
 *  data rather than as "which landing is this" (Callum, 2026-09-19). A touchdown with no
 *  resolved airfield falls back to its position in the whole sequence ("Landing 2"). The
 *  runway is still shown inside the card itself. */
/**
 * The control that picks which landing the card shows: tabs for a few landings, a dropdown for
 * more than LANDING_TAB_THRESHOLD.
 *
 * @param props The labels and ids of the landings, the selected index, and the handler.
 * @returns The element.
 */
function LandingSwitcher(props: {
  labels: string[]
  ids: number[]
  selectedIndex: number
  onSelect: (index: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { selectedIndex } = props
  return (
    <CardAction>
      {props.ids.length <= LANDING_TAB_THRESHOLD ? (
        <Tabs value={String(selectedIndex)} onValueChange={(v) => props.onSelect(Number(v))}>
          <TabsList aria-label={t('logbookView.landingCard.selectLanding')}>
            {props.ids.map((id, i) => (
              <TabsTrigger key={id} value={String(i)}>
                {props.labels[i]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : (
        <Select value={String(selectedIndex)} onValueChange={(v) => props.onSelect(Number(v))}>
          <SelectTrigger className="w-40" size="sm" aria-label={t('logbookView.landingCard.selectLanding')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {props.ids.map((id, i) => (
              <SelectItem key={id} value={String(i)}>
                {props.labels[i]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </CardAction>
  )
}

/**
 * The landing's measurements as a label / value list, with a warning mark on each one that
 * scored badly.
 *
 * @param props The landing, its score result, and the distance unit.
 * @returns The element.
 */
function LandingFields(props: {
  landing: LandingWithDetails
  scoreResult: LandingWithDetails['score']
  unit: LandingDistanceUnit
}): React.JSX.Element {
  const { t } = useTranslation()
  const { landing, scoreResult, unit } = props

  function categoryScore(key: LandingScoreCategoryKey): number | null {
    return scoreResult?.categories.find((c) => c.key === key)?.score ?? null
  }

  return (
    <dl className={cn(DETAIL_GRID_CLASS, 'min-w-0 flex-1')}>
      <DetailField
        label={t('logbookView.landingCard.landingScore')}
        value={<LandingScoreBadge score={scoreResult?.score ?? null} />}
        valueClassName="text-base font-semibold"
      />
      <DetailField
        label={t('logbookView.landingCard.touchdownRate')}
        warn={isCategoryBad(categoryScore('verticalSpeed'))}
        value={
          <span className="flex items-center gap-2">
            {Math.round(msToFpm(landing.verticalSpeedMs))} fpm
            {scoreResult && <LandingBadge severity={scoreResult.severity} />}
          </span>
        }
      />
      <DetailField
        label={t('logbookView.landingCard.gForce')}
        value={landing.gForce.toFixed(2)}
        warn={isCategoryBad(categoryScore('gForce'))}
      />
      <DetailField
        label={t('logbookView.landingCard.pitch')}
        value={formatPitchDeg(landing.pitchDeg)}
        warn={isCategoryBad(categoryScore('pitch'))}
      />
      <DetailField
        label={t('logbookView.landingCard.bank')}
        value={`${landing.bankDeg.toFixed(1)}°`}
        warn={isCategoryBad(categoryScore('bank'))}
      />
      <DetailField
        label={t('logbookView.landingCard.crab')}
        value={landing.crabDeg != null ? `${landing.crabDeg.toFixed(1)}°` : '—'}
        warn={isCategoryBad(categoryScore('crab'))}
      />
      <DetailField
        label={t('logbookView.landingCard.airspeedGroundSpeed')}
        value={`${Math.round(msToKt(landing.indicatedAirspeedMs))} / ${Math.round(msToKt(landing.groundSpeedMs))} kt`}
      />
      <DetailField
        label={t('logbookView.landingCard.headwindCrosswind')}
        value={
          landing.headwindMs != null && landing.crosswindMs != null
            ? `${Math.round(msToKt(landing.headwindMs))} / ${Math.round(msToKt(landing.crosswindMs))} kt`
            : '—'
        }
      />
      <DetailField label={t('logbookView.landingCard.runway')} value={landing.runwayIdent ?? '—'} />
      <DetailField
        label={t('logbookView.landingCard.distanceFromThreshold')}
        warn={isCategoryBad(categoryScore('distanceFromAimingPoint'))}
        value={
          landing.distanceFromThresholdM != null
            ? formatRunwayDistance(landing.distanceFromThresholdM, unit)
            : '—'
        }
      />
      <DetailField
        label={t('logbookView.landingCard.centrelineOffset')}
        warn={isCategoryBad(categoryScore('centrelineOffset'))}
        value={
          landing.centrelineOffsetM != null ? formatCentrelineOffset(landing.centrelineOffsetM, unit) : '—'
        }
      />
    </dl>
  )
}

/**
 * Exported so it's directly testable without mounting FlightDetail's FlightMap, which
 * LandingCard has no dependency on itself — LogbookView.test.tsx uses this.
 *
 * @param props The flight and the distance unit.
 * @returns The element.
 */
export function LandingCard(props: {
  flightId: number
  landingDistanceUnit: LandingDistanceUnit
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [landings, setLandings] = useState<LandingWithDetails[] | undefined>(undefined)
  // Index into `landings`, not a landing id — simpler to default ("the last one") and to
  // drive both the tabs and the select from the same piece of state. Reset per flight by
  // the fetch effect below, not derived inline, so switching flights doesn't strand the
  // previous flight's selected index against the new one's (possibly shorter) list.
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    runAsync(
      'LogbookView logbookListLandings',
      winglogApi().logbookListLandings(props.flightId).then((result) => {
        setLandings(result)
        // Defaults to the final touchdown — the one that ended the flight — matching
        // Logbook's own flights-list score column.
        setSelectedIndex(Math.max(0, result.length - 1))
      })
    )
  }, [props.flightId])

  // Still loading — render a skeleton at roughly the card's final height rather than
  // nothing, so the layout doesn't jump once the fetch resolves.
  if (landings === undefined) {
    return (
      <Card className="min-w-72 flex-1">
        <CardHeader>
          <CardTitle className="text-sm">{t('logbookView.landingCard.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (landings.length === 0) return null

  const labels = landingLabels(landings)
  const landing = landings[Math.min(selectedIndex, landings.length - 1)]
  const runway = landing.runway
  const scoreResult = landing.score
  const unit = props.landingDistanceUnit

  return (
    // `@container` + `@lg:` rather than the viewport's `sm:` - the card's width depends on
    // the layout around it (it wraps beside other cards), not just the window.
    <Card className="@container min-w-72 flex-1">
      <CardHeader>
        <CardTitle className="text-sm">{t('logbookView.landingCard.title')}</CardTitle>
        {landings.length > 1 && (
          <LandingSwitcher
            labels={labels}
            ids={landings.map((l) => l.id)}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
          />
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 @lg:flex-row @lg:items-start">
        <LandingFields landing={landing} scoreResult={scoreResult} unit={unit} />
        {scoreResult && (
          // The breakdown trigger lives in this same right-hand column, centred above the
          // diagram (Callum, 2026-09-13), rather than in the card header — a header
          // button's own right-alignment doesn't line up with this narrower column's
          // centre, and CardHeader/CardContent are separate layout contexts with no shared
          // width to align against. Rendered whenever a score exists, independent of the
          // diagram below it, since most categories still score without a runway match.
          <div className="flex w-full flex-shrink-0 flex-col items-center gap-2 self-start @lg:w-40">
            <LandingScoreBreakdownDialog
              overall={scoreResult.score}
              categories={scoreResult.categories}
              unit={unit}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  {t('logbookView.landingCard.scoreBreakdown')}
                </Button>
              }
            />
            {runway && landing.distanceFromThresholdM != null && (
              // No bigger than the field list it sits alongside (Callum, 2026-09-12: the
              // original width-only cap left height unconstrained, so a long runway's tall
              // window could still dwarf the text next to it) — fixed height, width
              // follows from the diagram's own aspect ratio (TouchdownDiagram.tsx).
              <div className="flex h-56 w-full justify-center">
                <TouchdownDiagram
                  runway={runway}
                  touchdown={{
                    distanceFromThresholdM: landing.distanceFromThresholdM,
                    centrelineOffsetM: landing.centrelineOffsetM ?? 0,
                    groundSpeedMs: landing.groundSpeedMs
                  }}
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
