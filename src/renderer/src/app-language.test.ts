import { describe, expect, it } from 'vitest'
import { resolveAppLanguage } from './app-language'

describe('resolveAppLanguage', () => {
  it('returns an explicit override verbatim, regardless of the system locale', () => {
    expect(resolveAppLanguage('de', 'en-US')).toBe('de')
    expect(resolveAppLanguage('fr', 'de-DE')).toBe('fr')
  })

  it("resolves 'system' to the OS locale's primary subtag when it's a supported language", () => {
    expect(resolveAppLanguage('system', 'de-DE')).toBe('de')
    expect(resolveAppLanguage('system', 'es-ES')).toBe('es')
    expect(resolveAppLanguage('system', 'fr-CH')).toBe('fr') // Switzerland — one of this app's own listed markets
    expect(resolveAppLanguage('system', 'it-IT')).toBe('it')
    expect(resolveAppLanguage('system', 'ru-RU')).toBe('ru')
    expect(resolveAppLanguage('system', 'en-GB')).toBe('en')
  })

  it("resolves 'system' to a bare language code with no region subtag", () => {
    expect(resolveAppLanguage('system', 'de')).toBe('de')
  })

  it("falls back to English for 'system' when the OS locale isn't a supported language", () => {
    expect(resolveAppLanguage('system', 'ja-JP')).toBe('en')
    expect(resolveAppLanguage('system', 'zh-CN')).toBe('en')
  })

  it("falls back to English for 'system' rather than throwing on a malformed locale string", () => {
    expect(resolveAppLanguage('system', '')).toBe('en')
  })

  it('is case-insensitive when matching the primary subtag', () => {
    expect(resolveAppLanguage('system', 'DE-de')).toBe('de')
  })
})
