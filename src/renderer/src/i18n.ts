// i18next bootstrap (docs/plans/v1-2.md Part 3) — initialized once, as a side-effecting
// import from main.tsx, before the app renders. Plain JSON catalogues, no build-time
// compiler/macro step (decisions.md, 2026-09-20 — the reason react-i18next + i18next was
// chosen over lingui). Scope is the renderer only for now: main-process strings (native
// dialog titles, the startup error box) aren't wired into this and stay English regardless
// of the language chosen here.
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en/common.json'
import de from './locales/de/common.json'
import es from './locales/es/common.json'
import fr from './locales/fr/common.json'
import it from './locales/it/common.json'
import ru from './locales/ru/common.json'

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: en },
    de: { common: de },
    es: { common: es },
    fr: { common: fr },
    it: { common: it },
    ru: { common: ru }
  },
  // Real language is set once App.tsx has read the persisted AppLanguage setting and
  // resolved it against the OS locale (app-language.ts's resolveAppLanguage) — English is
  // just this module's own load-time default, not a claim about what the user will see.
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  interpolation: { escapeValue: false }, // React already escapes; double-escaping mangles apostrophes etc.
  returnNull: false,
  // All resources are bundled upfront (no backend/lazy loader), so there's nothing to
  // suspend for — avoids every translated component needing its own Suspense boundary, in
  // both the real app and every renderer test.
  react: { useSuspense: false }
  // No initAsync/initImmediate setting needed here: i18next only defers init to a
  // setTimeout when it has no bundled `resources` to load synchronously from (see its own
  // init()) — since every catalogue above is already in memory, init() always finishes
  // synchronously on its own, avoiding a race where a component could render (in a test, or
  // on real app startup) before translations are ready.
})

export default i18n
