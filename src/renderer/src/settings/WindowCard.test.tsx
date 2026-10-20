import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WindowSettings } from '@shared/ipc'
import { WindowCard } from './WindowCard'

/** Installs a window.winglog whose window settings answer from `settings`, returning the mocks. */
function setup(settings: WindowSettings) {
  const api = {
    settingsGetWindow: vi.fn(() => Promise.resolve(settings)),
    settingsSetWindow: vi.fn(() => Promise.resolve()),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return api
}

describe('WindowCard', () => {
  it('offers the taskbar or the tray, starting on the taskbar, and saves the choice', async () => {
    const api = setup({ minimizeToTray: false, trayAvailable: true })
    render(<WindowCard />)
    expect(await screen.findByRole('button', { name: 'Taskbar' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'System tray' }))
    expect(api.settingsSetWindow).toHaveBeenCalledWith({ minimizeToTray: true })
    expect(screen.getByRole('button', { name: 'System tray' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows a saved tray choice, and can switch back to the taskbar', async () => {
    const api = setup({ minimizeToTray: true, trayAvailable: true })
    render(<WindowCard />)
    expect(await screen.findByRole('button', { name: 'System tray' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Taskbar' }))
    expect(api.settingsSetWindow).toHaveBeenCalledWith({ minimizeToTray: false })
  })

  it('shows nothing where there is no tray', async () => {
    const api = setup({ minimizeToTray: false, trayAvailable: false })
    const { container } = render(<WindowCard />)
    await vi.waitFor(() => expect(api.settingsGetWindow).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
