/** The GSX Remote tab. */

import { useTranslation } from 'react-i18next'
import { GsxRemotePanel } from './GsxRemotePanel'

/**
 * Its own top-level tab, not a Track popup — real GSX Remote
 * clients work as a standalone page, and this should too. The important-prompt banner that
 * can interrupt from anywhere else in the app lives in App.tsx, not here — this is just the
 * full, ordinary view of GSX's live state.
 *
 * @returns The element.
 */
export function GsxRemoteView(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold text-foreground">{t('gsxRemoteView.title')}</h1>
      <GsxRemotePanel />
    </div>
  )
}
