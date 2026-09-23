// Catalogue completeness check for the main process's own (small) i18n surface — same
// reasoning as the renderer's own src/renderer/src/locales/locales.test.ts: every
// non-English locale must have exactly the same set of keys as the English source of truth,
// catching a key added to one file and forgotten in the others before it ships as a silent
// missing-translation gap. This catalogue has no pluralized keys today, so no plural-suffix
// stripping is needed (unlike the renderer's own version of this test) — added back the
// day a main-process string first needs one.
import { describe, expect, it } from 'vitest'
import en from './en/main.json'
import de from './de/main.json'
import es from './es/main.json'
import fr from './fr/main.json'
import itLocale from './it/main.json'
import ru from './ru/main.json'
import zhCN from './zh-CN/main.json'
import zhTW from './zh-TW/main.json'

const CATALOGUES: Record<string, unknown> = { de, es, fr, it: itLocale, ru, 'zh-CN': zhCN, 'zh-TW': zhTW }

function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? keyPaths(value as Record<string, unknown>, path)
      : [path]
  })
}

describe('main-process locale catalogue completeness', () => {
  const englishKeys = keyPaths(en).sort()

  it('has at least one real key in the English source of truth', () => {
    expect(englishKeys.length).toBeGreaterThan(0)
  })

  it.each(Object.entries(CATALOGUES))('%s has exactly the same keys as English, no more, no fewer', (_locale, catalogue) => {
    expect(keyPaths(catalogue as Record<string, unknown>).sort()).toEqual(englishKeys)
  })
})
