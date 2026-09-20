import { afterEach, describe, expect, it } from 'vitest'
import { setMainLanguage, t } from './i18n'

describe('main-process i18n', () => {
  afterEach(() => {
    setMainLanguage('en', 'en-US')
  })

  it('defaults to English', () => {
    expect(t('errors.notConnectedToSim')).toBe('Not connected to the sim')
  })

  it('switches language on an explicit AppLanguage override, regardless of the system locale', () => {
    setMainLanguage('de', 'en-US')
    expect(t('errors.notConnectedToSim')).toBe('Nicht mit dem Simulator verbunden')
  })

  it("resolves 'system' against the OS locale, same as the renderer's own resolveAppLanguage", () => {
    setMainLanguage('system', 'fr-CH')
    expect(t('errors.notConnectedToSim')).toBe('Non connecté au simulateur')
  })

  it("falls back to English for 'system' when the OS locale isn't a supported language", () => {
    setMainLanguage('system', 'ja-JP')
    expect(t('errors.notConnectedToSim')).toBe('Not connected to the sim')
  })

  it('interpolates values into a translated message', () => {
    setMainLanguage('de', 'en-US')
    expect(t('errors.aircraftAlreadyRetired', { registration: 'G-ONE' })).toBe('G-ONE ist bereits ausgemustert')
  })
})
