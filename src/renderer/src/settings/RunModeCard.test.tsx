import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppCapabilities, RunMode } from '@shared/ipc'
import { CapabilitiesProvider } from '../app/capabilities'
import { RunModeCard } from './RunModeCard'

function setup(capabilities: AppCapabilities, chosen: RunMode | null = null) {
  const api = {
    appGetCapabilities: vi.fn(() => Promise.resolve(capabilities)),
    settingsGetRunMode: vi.fn(() => Promise.resolve(chosen)),
    settingsSetRunMode: vi.fn(() => Promise.resolve()),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return api
}

function renderCard(): ReturnType<typeof render> {
  return render(
    <CapabilitiesProvider>
      <RunModeCard />
    </CapabilitiesProvider>
  )
}

describe('RunModeCard', () => {
  it('offers this PC or another PC on a computer that can run the sim, saves the choice and says when it applies', async () => {
    const api = setup({ runMode: 'host', canHostSim: true, multiDevice: true })
    renderCard()
    expect(await screen.findByRole('button', { name: 'This PC' })).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByText('On a computer that connects to WingLog on the sim PC, choose “Another PC”.')
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Another PC' }))
    expect(api.settingsSetRunMode).toHaveBeenCalledWith('client')
    expect(screen.getByRole('button', { name: 'Another PC' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Takes effect the next time WingLog starts.')).toBeInTheDocument()
  })

  it('shows a choice saved for the next launch', async () => {
    setup({ runMode: 'host', canHostSim: true, multiDevice: true }, 'client')
    renderCard()
    await screen.findByRole('button', { name: 'Another PC' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Another PC' })).toHaveAttribute('aria-pressed', 'true')
    )
    expect(screen.getByText('Takes effect the next time WingLog starts.')).toBeInTheDocument()
  })

  it('shows nothing in a release build, which has no choice', async () => {
    const api = setup({ runMode: 'host', canHostSim: true, multiDevice: false })
    const { container } = renderCard()
    await vi.waitFor(() => expect(api.appGetCapabilities).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(api.settingsGetRunMode).not.toHaveBeenCalled()
  })

  it('shows nothing on a computer that cannot run the sim, which is always a client', async () => {
    const api = setup({ runMode: 'client', canHostSim: false, multiDevice: true })
    const { container } = renderCard()
    await vi.waitFor(() => expect(api.appGetCapabilities).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
