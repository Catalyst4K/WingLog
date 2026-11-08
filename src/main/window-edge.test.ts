import { beforeEach, describe, expect, it, vi } from 'vitest'

const { windows, handlers, nativeTheme, platform } = vi.hoisted(() => {
  const handlers: Record<string, () => void> = {}
  return {
    windows: [] as { isDestroyed: () => boolean; setAccentColor: ReturnType<typeof vi.fn> }[],
    handlers,
    nativeTheme: {
      shouldUseDarkColors: false,
      on: vi.fn((event: string, handler: () => void) => void (handlers[event] = handler))
    },
    platform: { value: 'win32' as 'win32' | 'darwin' | 'linux' }
  }
})

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => windows }, nativeTheme }))
vi.mock('./platform/platform', () => ({ currentPlatform: () => platform.value }))

import { applyWindowEdge, edgeColour, keepWindowEdgesInStep } from './window-edge'

describe('edgeColour', () => {
  it('is the page ground of the theme chosen', () => {
    expect(edgeColour('light', true)).toBe('#ebe8de')
    expect(edgeColour('dark', false)).toBe('#100f0e')
  })

  it('follows the system for "System"', () => {
    expect(edgeColour('system', true)).toBe('#100f0e')
    expect(edgeColour('system', false)).toBe('#ebe8de')
  })
})

describe('applying the edge to windows', () => {
  const window = (destroyed = false, fails = false) => {
    const setAccentColor = vi.fn(() => {
      if (fails) throw new Error('older Windows')
    })
    return { isDestroyed: () => destroyed, setAccentColor }
  }

  beforeEach(() => {
    windows.length = 0
    platform.value = 'win32'
    nativeTheme.shouldUseDarkColors = false
  })

  it('sets the edge colour of the theme on Windows', () => {
    const w = window()
    applyWindowEdge(w as never, 'dark')
    expect(w.setAccentColor).toHaveBeenCalledWith('#100f0e')
  })

  it('does nothing off Windows, for a window that is closing, or when the system refuses', () => {
    const mac = window()
    platform.value = 'darwin'
    applyWindowEdge(mac as never, 'dark')
    expect(mac.setAccentColor).not.toHaveBeenCalled()

    platform.value = 'win32'
    const closing = window(true)
    applyWindowEdge(closing as never, 'dark')
    expect(closing.setAccentColor).not.toHaveBeenCalled()

    expect(() => applyWindowEdge(window(false, true) as never, 'dark')).not.toThrow()
  })

  it('re-applies the edge to every window when asked, and when the system changes between light and dark', () => {
    let theme: 'light' | 'dark' | 'system' = 'light'
    const first = window()
    const second = window()
    windows.push(first, second)
    const apply = keepWindowEdgesInStep(() => theme)

    apply()
    expect(first.setAccentColor).toHaveBeenLastCalledWith('#ebe8de')
    expect(second.setAccentColor).toHaveBeenLastCalledWith('#ebe8de')

    theme = 'system'
    nativeTheme.shouldUseDarkColors = true
    handlers.updated()
    expect(first.setAccentColor).toHaveBeenLastCalledWith('#100f0e')
    expect(second.setAccentColor).toHaveBeenLastCalledWith('#100f0e')
  })
})
