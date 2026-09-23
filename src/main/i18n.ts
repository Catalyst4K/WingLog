// Main-process i18n (flightdeck-backend's docs/plans/v1-2.md Part 3) — a second,
// independent i18next instance from the renderer's own (src/renderer/src/i18n.ts), covering
// the handful of user-facing strings authored in this process: native dialog titles, the
// startup error box's title, and validation/business-rule messages that reach the renderer
// verbatim as a toast (see each throw site's own comment). Everything else shown to the
// user is either renderer-owned text or a caught exception's own message/stack (a
// third-party or OS failure, never ours to translate — see index.ts's startup error box).
import i18next, { type i18n as I18nInstance } from 'i18next'
import type { AppLanguage } from '@shared/ipc'
import { resolveAppLanguage } from '@shared/app-language'
import en from './locales/en/main.json'
import de from './locales/de/main.json'
import es from './locales/es/main.json'
import fr from './locales/fr/main.json'
import it from './locales/it/main.json'
import ru from './locales/ru/main.json'
import zhCN from './locales/zh-CN/main.json'
import zhTW from './locales/zh-TW/main.json'

const instance: I18nInstance = i18next.createInstance()
void instance.init({
  resources: {
    en: { main: en },
    de: { main: de },
    es: { main: es },
    fr: { main: fr },
    it: { main: it },
    ru: { main: ru },
    'zh-CN': { main: zhCN },
    'zh-TW': { main: zhTW }
  },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'main',
  interpolation: { escapeValue: false },
  returnNull: false
  // No initAsync/initImmediate needed — same reasoning as the renderer's own i18n.ts: every
  // catalogue is bundled upfront, so init() always resolves synchronously, before this
  // module's first caller ever gets a chance to call t().
})

/** Called once at startup with the persisted AppLanguage setting and the OS's own locale
 *  (app.getLocale()) — index.ts already reads both directly, no IPC round-trip needed
 *  (settings-repo.ts's getAppLanguage owns the same app_setting row the renderer reads) —
 *  and again whenever the user changes the setting in Settings, so a freshly thrown error
 *  picks up the new language immediately, with no restart required. */
export function setMainLanguage(setting: AppLanguage, systemLocale: string): void {
  void instance.changeLanguage(resolveAppLanguage(setting, systemLocale))
}

export function t(key: string, options?: Record<string, unknown>): string {
  return instance.t(key, options)
}
