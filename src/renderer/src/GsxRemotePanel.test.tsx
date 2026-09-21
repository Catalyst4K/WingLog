import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  GsxRemoteConnectionStatus,
  GsxRemoteMenuState,
  GsxRemotePromptState,
  GsxRemoteServiceStatus,
  GsxRemoteSettings,
  WingLogApi
} from '@shared/ipc'
import { GsxRemotePanel } from './GsxRemotePanel'

function makeSettings(overrides: Partial<GsxRemoteSettings> = {}): GsxRemoteSettings {
  return { enabled: true, host: 'localhost', port: 8744, ...overrides }
}

function makeStatus(overrides: Partial<GsxRemoteConnectionStatus> = {}): GsxRemoteConnectionStatus {
  return { state: 'connected', lastError: null, ...overrides }
}

function withWinglog(overrides: Partial<WingLogApi> = {}): void {
  window.winglog = {
    settingsGetGsxRemote: vi.fn().mockResolvedValue(makeSettings()),
    gsxRemoteGetStatus: vi.fn().mockResolvedValue(makeStatus()),
    onGsxRemoteStatus: vi.fn().mockReturnValue(() => {}),
    onGsxRemoteServices: vi.fn().mockReturnValue(() => {}),
    onGsxRemoteMenu: vi.fn().mockReturnValue(() => {}),
    onGsxRemotePrompt: vi.fn().mockReturnValue(() => {}),
    gsxRemotePickMenu: vi.fn().mockResolvedValue(undefined),
    gsxRemoteSubmitPrompt: vi.fn().mockResolvedValue(undefined),
    gsxRemoteCancelPrompt: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as WingLogApi
}

describe('GsxRemotePanel', () => {
  it('shows a not-configured message when GSX Remote is disabled', async () => {
    withWinglog({ settingsGetGsxRemote: vi.fn().mockResolvedValue(makeSettings({ enabled: false })) })
    render(<GsxRemotePanel />)

    expect(await screen.findByText(/GSX Remote Control is off/)).toBeInTheDocument()
  })

  it('shows a not-configured message when enabled but no port is set', async () => {
    withWinglog({ settingsGetGsxRemote: vi.fn().mockResolvedValue(makeSettings({ enabled: true, port: null })) })
    render(<GsxRemotePanel />)

    expect(await screen.findByText(/GSX Remote Control is off/)).toBeInTheDocument()
  })

  it('shows a connecting message while not yet connected', async () => {
    withWinglog({ gsxRemoteGetStatus: vi.fn().mockResolvedValue(makeStatus({ state: 'connecting' })) })
    render(<GsxRemotePanel />)

    expect(await screen.findByText('Connecting to GSX…')).toBeInTheDocument()
  })

  it('shows an empty-menu message once connected with no menu open', async () => {
    withWinglog()
    render(<GsxRemotePanel />)

    expect(await screen.findByText(/No menu open/)).toBeInTheDocument()
  })

  it('renders the live menu generically and picks an entry by index', async () => {
    let servicesListener: (services: GsxRemoteServiceStatus[]) => void = () => {}
    let menuListener: (menu: GsxRemoteMenuState) => void = () => {}
    const gsxRemotePickMenu = vi.fn().mockResolvedValue(undefined)
    withWinglog({
      gsxRemotePickMenu,
      onGsxRemoteServices: vi.fn((listener) => {
        servicesListener = listener
        return () => {}
      }),
      onGsxRemoteMenu: vi.fn((listener) => {
        menuListener = listener
        return () => {}
      })
    })
    render(<GsxRemotePanel />)
    await screen.findByText(/No menu open/)

    menuListener({
      title: 'Ground Services',
      header: '',
      subtitle: '',
      entries: ['Request Refueling', 'Request Catering'],
      icons: ['', ''],
      disabled: [false, true],
      layout: 't9'
    })
    servicesListener([])

    const refuel = await screen.findByRole('button', { name: 'Request Refueling' })
    expect(refuel).toBeEnabled()
    const catering = screen.getByRole('button', { name: 'Request Catering' })
    expect(catering).toBeDisabled()

    const user = userEvent.setup()
    await user.click(refuel)
    expect(gsxRemotePickMenu).toHaveBeenCalledWith(0)
  })

  it('shows service status once services arrive', async () => {
    let servicesListener: (services: GsxRemoteServiceStatus[]) => void = () => {}
    withWinglog({
      onGsxRemoteServices: vi.fn((listener) => {
        servicesListener = listener
        return () => {}
      })
    })
    render(<GsxRemotePanel />)
    await screen.findByText(/No menu open/)

    servicesListener([
      {
        id: 'Refueling',
        displayName: 'Refuel',
        state: 'requested',
        stateText: 'Refueling service has been requested',
        icon: 'refueling',
        canTrigger: false,
        canBypass: false,
        operator: 'World Fuel Services',
        statusText: 'on the way, ETA 24 secs',
        progressText: ''
      }
    ])

    expect(await screen.findByText('Refuel')).toBeInTheDocument()
    expect(screen.getByText(/on the way, ETA 24 secs/)).toBeInTheDocument()
    expect(screen.getByText(/World Fuel Services/)).toBeInTheDocument()
  })

  it('shows a text prompt and submits the typed answer', async () => {
    let promptListener: (prompt: GsxRemotePromptState | null) => void = () => {}
    const gsxRemoteSubmitPrompt = vi.fn().mockResolvedValue(undefined)
    withWinglog({
      gsxRemoteSubmitPrompt,
      onGsxRemotePrompt: vi.fn((listener) => {
        promptListener = listener
        return () => {}
      })
    })
    render(<GsxRemotePanel />)
    await screen.findByText(/No menu open/)

    promptListener({ kind: 'text', gen: 7, title: 'Save Location', description: '', default: '', maxLength: 64 })
    const input = await screen.findByRole('textbox')
    const user = userEvent.setup()
    await user.type(input, 'Gate 12')
    await user.click(screen.getByRole('button', { name: 'OK' }))

    expect(gsxRemoteSubmitPrompt).toHaveBeenCalledWith(7, 'Gate 12')
  })

  it('cancels a text prompt', async () => {
    let promptListener: (prompt: GsxRemotePromptState | null) => void = () => {}
    const gsxRemoteCancelPrompt = vi.fn().mockResolvedValue(undefined)
    withWinglog({
      gsxRemoteCancelPrompt,
      onGsxRemotePrompt: vi.fn((listener) => {
        promptListener = listener
        return () => {}
      })
    })
    render(<GsxRemotePanel />)
    await screen.findByText(/No menu open/)

    promptListener({ kind: 'text', gen: 9, title: 'Rename', description: '', default: 'Flight 1', maxLength: 64 })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(gsxRemoteCancelPrompt).toHaveBeenCalledWith(9)
  })

  it('unsubscribes from every live channel on unmount', async () => {
    const unsubscribeStatus = vi.fn()
    const unsubscribeServices = vi.fn()
    const unsubscribeMenu = vi.fn()
    const unsubscribePrompt = vi.fn()
    withWinglog({
      onGsxRemoteStatus: vi.fn().mockReturnValue(unsubscribeStatus),
      onGsxRemoteServices: vi.fn().mockReturnValue(unsubscribeServices),
      onGsxRemoteMenu: vi.fn().mockReturnValue(unsubscribeMenu),
      onGsxRemotePrompt: vi.fn().mockReturnValue(unsubscribePrompt)
    })
    const { unmount } = render(<GsxRemotePanel />)
    await screen.findByText(/No menu open/)

    unmount()

    await waitFor(() => {
      expect(unsubscribeStatus).toHaveBeenCalled()
      expect(unsubscribeServices).toHaveBeenCalled()
      expect(unsubscribeMenu).toHaveBeenCalled()
      expect(unsubscribePrompt).toHaveBeenCalled()
    })
  })
})
