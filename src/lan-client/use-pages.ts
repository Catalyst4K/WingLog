/** Which pages the bar offers. */

import { useMemo } from 'react'
import { Radar, Radio, Route, Truck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PageEntry } from './NavBar'
import type { PcSettings } from './use-pc-settings'

/**
 * The pages to offer: Track and Dispatch (which carries the weather) always, and Ground services and BeyondATC only when they are switched on at the PC.
 *
 * @param settings What the PC says is switched on.
 * @returns The pages, in order.
 */
export function usePages(settings: Pick<PcSettings, 'gsxRemote' | 'beyondAtc'>): PageEntry[] {
  const { t } = useTranslation()
  return useMemo(
    () => [
      { id: 'track', label: t('app.tabs.track'), icon: Radar },
      { id: 'dispatch', label: t('app.tabs.dispatch'), icon: Route },
      ...(settings.gsxRemote ? [{ id: 'gsx' as const, label: t('app.tabs.gsx'), icon: Truck }] : []),
      ...(settings.beyondAtc
        ? [{ id: 'beyondatc' as const, label: t('app.tabs.beyondAtc'), icon: Radio }]
        : [])
    ],
    [t, settings.gsxRemote, settings.beyondAtc]
  )
}
