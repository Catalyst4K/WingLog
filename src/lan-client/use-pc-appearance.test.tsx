import { act, renderHook } from '@testing-library/react'
import i18n from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePcAppearance } from './use-pc-appearance'

type Appearance = Parameters<typeof usePcAppearance>[0]

/** A phone whose own light or dark can be flipped, as the OS does. */
function stubMatchMedia(initialDark: boolean): { flip: (dark: boolean) => void } {
  let dark = initialDark
  const listeners = new Set<() => void>()
  window.matchMedia = vi.fn(() => ({
    get matches() {
      return dark
    },
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l)
  })) as unknown as typeof window.matchMedia
  return {
    flip: (next) => {
      dark = next
      listeners.forEach((l) => l())
    }
  }
}

describe('usePcAppearance', () => {
  beforeEach(async () => {
    document.documentElement.classList.remove('dark')
    await i18n.changeLanguage('en')
  })
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it("follows the PC's language, and its OS language when the PC is set to system", async () => {
    stubMatchMedia(false)
    const { rerender } = renderHook(({ s }: { s: Appearance }) => usePcAppearance(s), {
      initialProps: { s: { appLanguage: 'de', systemLocale: 'en-US', theme: 'system' } as Appearance }
    })
    await act(() => Promise.resolve())
    expect(i18n.language).toBe('de')

    rerender({ s: { appLanguage: 'system', systemLocale: 'fr-FR', theme: 'system' } })
    await act(() => Promise.resolve())
    expect(i18n.language).toBe('fr')

    rerender({ s: { appLanguage: 'zh-TW', systemLocale: 'fr-FR', theme: 'system' } })
    await act(() => Promise.resolve())
    expect(i18n.language).toBe('zh-TW')
  })

  it('applies an explicit dark or light, and for system follows this phone as it changes', () => {
    const media = stubMatchMedia(false)
    const { rerender } = renderHook(({ s }: { s: Appearance }) => usePcAppearance(s), {
      initialProps: { s: { appLanguage: 'en', systemLocale: 'en', theme: 'dark' } as Appearance }
    })
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    rerender({ s: { appLanguage: 'en', systemLocale: 'en', theme: 'light' } })
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    rerender({ s: { appLanguage: 'en', systemLocale: 'en', theme: 'system' } })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    act(() => media.flip(true))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('leaves the page as it is on a browser with no matchMedia', () => {
    const real = window.matchMedia
    // @ts-expect-error a browser without it
    window.matchMedia = undefined
    document.documentElement.classList.add('dark')
    renderHook(() => usePcAppearance({ appLanguage: 'en', systemLocale: 'en', theme: 'system' }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    window.matchMedia = real
  })
})
