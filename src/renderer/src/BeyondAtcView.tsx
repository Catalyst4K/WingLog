/** The BeyondATC tab. */

import { useTranslation } from 'react-i18next'
import { BeyondAtcPanel } from './BeyondAtcPanel'

/**
 * Its own top-level tab, like GSX Remote Control's: both are gated on their own settings' `enabled` flag by App.tsx's
 * `appTabs`, so this view only mounts once BeyondATC integration is turned on.
 *
 * `h-full min-h-0` propagates App.tsx's viewport-bounded content height down into `BeyondAtcPanel` (winglog-backend's
 * docs/plans/beyondatc-panel-redesign.md). Without it, the Transcript card's internal scroll area has no height to bound
 * against and grows with every line, and the whole page scrolls instead of the card's own list. Every other tab keeps relying
 * on App.tsx's own `overflow-auto`; this only changes BeyondATC's own subtree.
 *
 * @returns The element.
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
