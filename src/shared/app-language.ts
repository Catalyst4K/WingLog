// Resolves AppLanguage's 'system' value to an actual language i18next can load — pure
// logic, testable without a live Electron/OS locale (docs/plans/v1-2.md Part 3). Lives in
// src/shared rather than src/renderer since both the renderer's own i18next instance
// (i18n.ts) and the main process's (src/main/i18n.ts, main-process strings) need it — main
// already reads the persisted AppLanguage setting directly (settings-repo.ts's
// getAppLanguage) and calls app.getLocale() itself, with no IPC round-trip either way.
import type { AppLanguage } from '@shared/ipc'

/** Every language this app actually has a catalogue for, English included — the set
 *  i18next is initialized with (i18n.ts) and the set SUPPORTED_APP_LANGUAGES's own values
 *  (minus 'system') are checked against below. Growing this means adding a real catalogue
 *  under locales/<code>/, not just adding a code here. */
export const SUPPORTED_LANGUAGES = ['en', 'de', 'es', 'fr', 'it', 'ru'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/**
 * `setting` is what's persisted (AppLanguage, including 'system'); `systemLocale` is
 * whatever Electron's `app.getLocale()` reports (e.g. "en-US", "de-DE", "fr"). An explicit
 * override always wins outright. 'system' takes just the locale's primary language subtag
 * (before any '-') and checks it against the languages this app actually has a catalogue
 * for; anything else — an unsupported language, or a locale string that doesn't parse —
 * falls back to English, never throws.
 */
export function resolveAppLanguage(setting: AppLanguage, systemLocale: string): SupportedLanguage {
  if (setting !== 'system') return setting
  // String.split always returns at least one element, even for '' — never undefined.
  const primarySubtag = systemLocale.split('-')[0].toLowerCase()
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(primarySubtag) ? (primarySubtag as SupportedLanguage) : 'en'
}

/** SettingsView's own language picker options — each language's own native name, not its
 *  English one (a Russian speaker shouldn't have to read "Russian" to find "Русский"). */
export const APP_LANGUAGE_OPTIONS: readonly { value: AppLanguage; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italiano' },
  { value: 'ru', label: 'Русский' }
]
