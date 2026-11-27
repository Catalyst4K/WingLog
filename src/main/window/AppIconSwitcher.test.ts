import { describe, expect, it, vi } from 'vitest'
import type { Platform } from '../platform/platform'
import { AppIconSwitcher } from './AppIconSwitcher'

function build(platform: Platform, initialPath: string) {
  let path = initialPath
  const deps = {
    platform,
    currentIconPath: () => path,
    setTrayIcon: vi.fn(),
    setWindowIcon: vi.fn(),
    setDockIcon: vi.fn()
  }
  return {
    deps,
    switcher: new AppIconSwitcher(deps),
    changeTo: (next: string) => {
      path = next
    }
  }
}

describe('AppIconSwitcher', () => {
  it('puts the picture on the tray and the window on Windows, never the Dock', () => {
    const { deps, switcher } = build('win32', 'icon.png')
    switcher.apply()
    expect(deps.setTrayIcon).toHaveBeenCalledWith('icon.png')
    expect(deps.setWindowIcon).toHaveBeenCalledWith('icon.png')
    expect(deps.setDockIcon).not.toHaveBeenCalled()
  })

  it('puts the picture on the Dock, not the window, on macOS', () => {
    const { deps, switcher } = build('darwin', 'icon.png')
    switcher.apply()
    expect(deps.setDockIcon).toHaveBeenCalledWith('icon.png')
    expect(deps.setWindowIcon).not.toHaveBeenCalled()
  })

  it('uses the window icon on Linux', () => {
    const { deps, switcher } = build('linux', 'icon.png')
    switcher.apply()
    expect(deps.setWindowIcon).toHaveBeenCalledWith('icon.png')
    expect(deps.setDockIcon).not.toHaveBeenCalled()
  })

  it('applies the picture for the setting at the time, each time the system changes', () => {
    const { deps, switcher, changeTo } = build('win32', 'icon.png')
    switcher.apply()
    changeTo('icon-dark.png')
    switcher.apply()
    expect(deps.setTrayIcon).toHaveBeenNthCalledWith(1, 'icon.png')
    expect(deps.setTrayIcon).toHaveBeenNthCalledWith(2, 'icon-dark.png')
    expect(deps.setWindowIcon).toHaveBeenLastCalledWith('icon-dark.png')
  })
})
