import { useTranslation } from 'react-i18next'
import { BeyondAtcPanel } from './BeyondAtcPanel'

/**
 * Its own top-level tab, same call as GSX Remote Control's (Callum, 2026-09-27) — both are
 * gated on their own settings' `enabled` flag by App.tsx's `appTabs`, so this view only ever
 * mounts once BeyondATC integration is actually turned on.
 *
 * `h-full min-h-0` propagates App.tsx's real, viewport-bounded content height down into
 * `BeyondAtcPanel` (winglog-backend's docs/plans/beyondatc-panel-redesign.md) — without
 * it, the Transcript card's internal scroll area has no real height to bound against and
 * just grows with every line, and the whole page scrolls instead of the card's own list
 * (confirmed live via a Playwright screenshot + DOM rect dump, real bug found and fixed the
 * same evening, not a hypothetical). Every other tab keeps relying on App.tsx's own
 * `overflow-auto` unaffected — this only changes BeyondATC's own subtree.
 */
export function BeyondAtcView(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold text-foreground">{t('beyondAtcView.title')}</h1>
      <BeyondAtcPanel />
    </div>
  )
}
