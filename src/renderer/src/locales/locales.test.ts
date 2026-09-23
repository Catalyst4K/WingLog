// Catalogue completeness check (docs/plans/v1-2.md Part 3: "each catalogue gets a
// completeness check") — every non-English locale must have exactly the same set of keys
// as the English source of truth. Catches a key added to one file and forgotten in the
// others before it ships as a silent missing-translation gap, rather than after.
import { describe, expect, it } from 'vitest'
import en from './en/common.json'
import de from './de/common.json'
import es from './es/common.json'
import fr from './fr/common.json'
import itLocale from './it/common.json'
import ru from './ru/common.json'
import zhCN from './zh-CN/common.json'
import zhTW from './zh-TW/common.json'

const CATALOGUES: Record<string, unknown> = { de, es, fr, it: itLocale, ru, 'zh-CN': zhCN, 'zh-TW': zhTW }

// i18next plural suffixes (CLDR categories) — a key like "excludedCount_one" and
// "excludedCount_few" are the same logical string in different languages' plural forms, not
// separate translatable concepts, so different locales are allowed to define a different
// *set* of these (Russian's one/few/many/other vs. English's one/other) for the same base
// key without failing the completeness check below.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

/** Every leaf key path in a nested translation object, e.g. "landingScoreBreakdown.title" —
 *  with any trailing plural suffix stripped back to its base key first. */
function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const paths = Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? keyPaths(value as Record<string, unknown>, path)
      : [path.replace(PLURAL_SUFFIX, '')]
  })
  return [...new Set(paths)]
}

describe('locale catalogue completeness', () => {
  const englishKeys = keyPaths(en).sort()

  it('has at least one real key in the English source of truth', () => {
    expect(englishKeys.length).toBeGreaterThan(0)
  })

  it.each(Object.entries(CATALOGUES))('%s has exactly the same keys as English, no more, no fewer', (_locale, catalogue) => {
    expect(keyPaths(catalogue as Record<string, unknown>).sort()).toEqual(englishKeys)
  })
})
