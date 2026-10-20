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
  it('offers quit or the tray, starting on quit, and saves the choice', async () => {
    const api = setup({ closeToTray: false, trayAvailable: true })
    render(<WindowCard />)
    expect(await screen.findByRole('button', { name: 'Quit WingLog' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Keep running in the tray' }))
    expect(api.settingsSetWindow).toHaveBeenCalledWith({ closeToTray: true })
    expect(screen.getByRole('button', { name: 'Keep running in the tray' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('shows a saved tray choice, and can switch back to quitting', async () => {
    const api = setup({ closeToTray: true, trayAvailable: true })
    render(<WindowCard />)
    expect(await screen.findByRole('button', { name: 'Keep running in the tray' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Quit WingLog' }))
    expect(api.settingsSetWindow).toHaveBeenCalledWith({ closeToTray: false })
  })

  it('shows nothing where there is no tray', async () => {
    const api = setup({ closeToTray: false, trayAvailable: false })
    const { container } = render(<WindowCard />)
    await vi.waitFor(() => expect(api.settingsGetWindow).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
