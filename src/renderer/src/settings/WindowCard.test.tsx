import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WindowSettings } from '@shared/ipc'
import { WindowCard } from './WindowCard'

/** Installs a window.winglog whose window settings answer from `settings`, returning the mocks. */
function setup(settings: Partial<WindowSettings> & Pick<WindowSettings, 'minimizeToTray' | 'trayAvailable'>) {
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

  const background = {
    minimizeToTray: false,
    trayAvailable: true,
    hostOnly: false,
    backgroundAvailable: true,
    startWithWindows: false,
    startWithWindowsAvailable: true
  }

  it('offers running in the background and starting with Windows, and saves each on its own', async () => {
    const api = setup(background)
    render(<WindowCard />)
    const runInBackground = await screen.findByRole('group', { name: 'Run in the background' })
    await userEvent.click(within(runInBackground).getByRole('button', { name: 'On' }))
    expect(api.settingsSetWindow).toHaveBeenLastCalledWith({ hostOnly: true })
    expect(within(runInBackground).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true')
    const startWithWindows = screen.getByRole('group', { name: 'Start with Windows' })
    await userEvent.click(within(startWithWindows).getByRole('button', { name: 'On' }))
    expect(api.settingsSetWindow).toHaveBeenLastCalledWith({ startWithWindows: true })
  })

  it('does not offer them where they are not available, and offers only the first for a development run', async () => {
    setup({ ...background, backgroundAvailable: false, startWithWindowsAvailable: false })
    const { unmount } = render(<WindowCard />)
    await screen.findByRole('button', { name: 'Taskbar' })
    expect(screen.queryByText('Run in the background')).not.toBeInTheDocument()
    unmount()
    setup({ ...background, startWithWindowsAvailable: false })
    render(<WindowCard />)
    await screen.findByRole('group', { name: 'Run in the background' })
    expect(screen.queryByText('Start with Windows')).not.toBeInTheDocument()
  })

  it('shows nothing where there is no tray', async () => {
    const api = setup({ minimizeToTray: false, trayAvailable: false })
    const { container } = render(<WindowCard />)
    await vi.waitFor(() => expect(api.settingsGetWindow).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
