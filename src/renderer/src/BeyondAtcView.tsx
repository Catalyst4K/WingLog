import { useTranslation } from 'react-i18next'
import { BeyondAtcPanel } from './BeyondAtcPanel'

/**
 * Its own top-level tab, same call as GSX Remote Control's (Callum, 2026-09-27) — both are
 * gated on their own settings' `enabled` flag by App.tsx's `appTabs`, so this view only ever
 * mounts once BeyondATC integration is actually turned on.
 */
export function BeyondAtcView(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold text-foreground">{t('beyondAtcView.title')}</h1>
      <BeyondAtcPanel />
    </div>
  )
}
