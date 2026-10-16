/** Makes the page look the way the PC's settings say: its language and its light or dark. */

import { useEffect } from 'react'
import i18n from 'i18next'
import { resolveAppLanguage } from '@shared/app-language'
import { runAsync } from '@/report-error'
import type { PcSettings } from './use-pc-settings'

/**
 * Follows the PC's language and theme settings (winglog's Settings → Display): changing either on the PC changes the page within a few
 * seconds. "System" language is the PC's own OS language; "system" theme is this phone's own light or dark, which is the one that makes
 * sense on a phone.
 *
 * @param settings The PC's settings, or the defaults until it has answered (then the page keeps looking as it always did).
 */
export function usePcAppearance(settings: Pick<PcSettings, 'appLanguage' | 'systemLocale' | 'theme'>): void {
  const { appLanguage, systemLocale, theme } = settings

  useEffect(() => {
    const language = resolveAppLanguage(appLanguage, systemLocale)
    if (i18n.language !== language) runAsync('phone language', i18n.changeLanguage(language))
  }, [appLanguage, systemLocale])

  useEffect(() => {
    // A browser without matchMedia just keeps the light or dark the page started with.
    const media =
      typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && media?.matches === true)
      document.documentElement.classList.toggle('dark', dark)
    }
    if (!media && theme === 'system') return
    apply()
    if (theme !== 'system' || !media) return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}
