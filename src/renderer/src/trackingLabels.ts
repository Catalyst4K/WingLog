import type { TFunction } from 'i18next'

/** The real (translated) labels of the buttons and pages the Tracking settings point at. */
export function trackingLabels(t: TFunction): Record<string, string> {
  return {
    fly: t('dispatchView.fly'),
    startTracking: t('trackView.startTracking'),
    finishAndSave: t('trackView.finishAndSave'),
    dispatch: t('app.tabs.dispatch'),
    track: t('app.tabs.track')
  }
}
