import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  GsxRemoteConnectionStatus,
  GsxRemoteGateInfo,
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
    gsxRemoteGetServices: vi.fn().mockResolvedValue([]),
    onGsxRemoteServices: vi.fn().mockReturnValue(() => {}),
    gsxRemoteGetGateInfo: vi.fn().mockResolvedValue(null),
    onGsxRemoteGate: vi.fn().mockReturnValue(() => {}),
    gsxRemoteGetMenu: vi.fn().mockResolvedValue({ menuShown: false, title: '', header: '', subtitle: '', entries: [], icons: [], disabled: [], layout: '' }),
    onGsxRemoteMenu: vi.fn().mockReturnValue(() => {}),
    gsxRemoteGetPrompt: vi.fn().mockResolvedValue(null),
    onGsxRemotePrompt: vi.fn().mockReturnValue(() => {}),
    gsxRemoteGetCommandBar: vi.fn().mockResolvedValue({ commands: [], simbrief: null, simbriefIconUri: null }),
    onGsxRemoteCommandBar: vi.fn().mockReturnValue(() => {}),
    gsxRemotePickMenu: vi.fn().mockResolvedValue(undefined),
    gsxRemoteToggleMenu: vi.fn().mockResolvedValue(undefined),
    gsxRemoteSubmitPrompt: vi.fn().mockResolvedValue(undefined),
    gsxRemoteCancelPrompt: vi.fn().mockResolvedValue(undefined),
    gsxRemoteRunCommand: vi.fn().mockResolvedValue(undefined),
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

  it('shows the closed-menu header once connected with no menu open', async () => {
    withWinglog()
    render(<GsxRemotePanel />)

    expect(await screen.findByText('GSX Menu')).toBeInTheDocument()
    expect(screen.getByText('Tap to open')).toBeInTheDocument()
  })

  it('clicking the header calls gsxRemoteToggleMenu', async () => {
    const gsxRemoteToggleMenu = vi.fn().mockResolvedValue(undefined)
    withWinglog({ gsxRemoteToggleMenu })
    const user = userEvent.setup()
    render(<GsxRemotePanel />)
    await screen.findByText('Tap to open')

    await user.click(screen.getByRole('button', { name: /GSX Menu/ }))

    expect(gsxRemoteToggleMenu).toHaveBeenCalled()
  })

  it('does not render entries while menuShown is false, even with stale entries present', async () => {
    let menuListener: (menu: GsxRemoteMenuState) => void = () => {}
    withWinglog({
      onGsxRemoteMenu: vi.fn((listener) => {
        menuListener = listener
        return () => {}
      })
    })
    render(<GsxRemotePanel />)
    await screen.findByText('Tap to open')

    menuListener({
      menuShown: false,
      title: 'Ground Services',
      header: '',
      subtitle: '',
      entries: ['Request Refueling', 'Request Catering'],
      icons: ['', ''],
      disabled: [false, false],
      layout: 't9'
    })

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Request Refueling' })).not.toBeInTheDocument())
    expect(screen.getByText('Tap to open')).toBeInTheDocument()
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
    await screen.findByText('Tap to open')

    menuListener({
      menuShown: true,
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
    await screen.findByText('Tap to open')

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
    // Labelled explicitly ("Provider: X") rather than the bare name alone, so it isn't
    // mistaken for the service's own status — Callum's call after seeing an early build.
    expect(screen.getByText('Provider: World Fuel Services')).toBeInTheDocument()
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
    await screen.findByText('Tap to open')

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
    await screen.findByText('Tap to open')

    promptListener({ kind: 'text', gen: 9, title: 'Rename', description: '', default: 'Flight 1', maxLength: 64 })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(gsxRemoteCancelPrompt).toHaveBeenCalledWith(9)
  })

  it('unsubscribes from every live channel on unmount', async () => {
    const unsubscribeStatus = vi.fn()
    const unsubscribeServices = vi.fn()
    const unsubscribeGate = vi.fn()
    const unsubscribeMenu = vi.fn()
    const unsubscribePrompt = vi.fn()
    const unsubscribeCommandBar = vi.fn()
    withWinglog({
      onGsxRemoteStatus: vi.fn().mockReturnValue(unsubscribeStatus),
      onGsxRemoteServices: vi.fn().mockReturnValue(unsubscribeServices),
      onGsxRemoteGate: vi.fn().mockReturnValue(unsubscribeGate),
      onGsxRemoteMenu: vi.fn().mockReturnValue(unsubscribeMenu),
      onGsxRemotePrompt: vi.fn().mockReturnValue(unsubscribePrompt),
      onGsxRemoteCommandBar: vi.fn().mockReturnValue(unsubscribeCommandBar)
    })
    const { unmount } = render(<GsxRemotePanel />)
    await screen.findByText('Tap to open')

    unmount()

    await waitFor(() => {
      expect(unsubscribeStatus).toHaveBeenCalled()
      expect(unsubscribeServices).toHaveBeenCalled()
      expect(unsubscribeGate).toHaveBeenCalled()
      expect(unsubscribeMenu).toHaveBeenCalled()
      expect(unsubscribePrompt).toHaveBeenCalled()
      expect(unsubscribeCommandBar).toHaveBeenCalled()
    })
  })

  it('shows the gate GSX has resolved, split into a headline label and a subtitle', async () => {
    withWinglog({
      gsxRemoteGetGateInfo: vi.fn().mockResolvedValue({
        airportIcao: 'VHHH',
        airportName: 'Hong Kong Intl',
        parking: '(N) T1 North|Gate N6',
        gateProperties: ['Gate Heavy', 'jetway']
      } satisfies GsxRemoteGateInfo)
    })
    render(<GsxRemotePanel />)

    expect(await screen.findByText('Gate N6')).toBeInTheDocument()
    expect(screen.getByText('VHHH · Hong Kong Intl · (N) T1 North')).toBeInTheDocument()
    // gateProperties is GSX's own free-text amenity-tag list, rendered as plain badges.
    expect(screen.getByText('Gate Heavy')).toBeInTheDocument()
    expect(screen.getByText('jetway')).toBeInTheDocument()
  })

  it('shows no amenity badges when GSX reports none for the gate', async () => {
    withWinglog({
      gsxRemoteGetGateInfo: vi.fn().mockResolvedValue({
        airportIcao: 'VHHH',
        airportName: 'Hong Kong Intl',
        parking: '(N) T1 North|Gate N6',
        gateProperties: []
      } satisfies GsxRemoteGateInfo)
    })
    render(<GsxRemotePanel />)

    expect(await screen.findByText('Gate N6')).toBeInTheDocument()
    expect(screen.queryByText('jetway')).not.toBeInTheDocument()
  })

  it('renders nothing for the gate section before GSX has resolved one', async () => {
    withWinglog()
    render(<GsxRemotePanel />)
    await screen.findByText('Tap to open')

    expect(screen.queryByText(/VHHH/)).not.toBeInTheDocument()
  })

  it('shows services/menu/prompt already known at mount, not just future pushes', async () => {
    // A real gap found writing this feature's Playwright test: GSX only pushes
    // services/menu/prompt on a *change*, so a panel mounting (or remounting) after GSX
    // already sent its snapshot needs its own current-value fetch, same as status/gate
    // already had — otherwise it shows nothing until the next patch happens to arrive.
    withWinglog({
      gsxRemoteGetServices: vi.fn().mockResolvedValue([
        { id: 'Boarding', displayName: 'Board', state: 'requested', stateText: '', icon: '', canTrigger: false, canBypass: false, statusText: 'Already in progress', progressText: '' }
      ]),
      gsxRemoteGetMenu: vi.fn().mockResolvedValue({
        menuShown: true,
        title: 'Already-open menu',
        header: '',
        subtitle: '',
        entries: ['Option A'],
        icons: [],
        disabled: [false],
        layout: 'list'
      }),
      gsxRemoteGetPrompt: vi.fn().mockResolvedValue({
        kind: 'text',
        gen: 5,
        title: 'Already-open prompt',
        description: '',
        default: '',
        maxLength: 64
      })
    })
    render(<GsxRemotePanel />)

    expect(await screen.findByText('Board')).toBeInTheDocument()
    expect(screen.getByText('Already in progress')).toBeInTheDocument()
    expect(screen.getByText('Already-open menu')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Option A' })).toBeInTheDocument()
    expect(screen.getByText('Already-open prompt')).toBeInTheDocument()
  })

  it('hides idle secondary services behind a "show more" toggle, keeps primary/active ones visible', async () => {
    let servicesListener: (services: GsxRemoteServiceStatus[]) => void = () => {}
    withWinglog({
      onGsxRemoteServices: vi.fn((listener) => {
        servicesListener = listener
        return () => {}
      })
    })
    render(<GsxRemotePanel />)
    await screen.findByText('Tap to open')

    servicesListener([
      { id: 'Boarding', displayName: 'Board', state: 'requested', stateText: '', icon: '', canTrigger: false, canBypass: false, statusText: '', progressText: '' },
      { id: 'GPU', displayName: 'GPU', state: 'available', stateText: '', icon: '', canTrigger: true, canBypass: false, statusText: '', progressText: '' },
      { id: 'DeIce', displayName: 'De-Ice', state: 'performing', stateText: '', icon: '', canTrigger: false, canBypass: false, statusText: '', progressText: '' }
    ])

    expect(await screen.findByText('Board')).toBeInTheDocument()
    expect(screen.getByText('De-Ice')).toBeInTheDocument() // active secondary service, shown directly
    // Idle secondary service: present but folded inside a closed <details>, not shown directly.
    expect(screen.getByText('GPU').closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('Show 1 more service')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByText('Show 1 more service'))

    expect(screen.getByText('GPU').closest('details')).toHaveAttribute('open')
  })

  it('shows a service\'s live bill and formatted fuel progress instead of raw statusText', async () => {
    let servicesListener: (services: GsxRemoteServiceStatus[]) => void = () => {}
    withWinglog({
      onGsxRemoteServices: vi.fn((listener) => {
        servicesListener = listener
        return () => {}
      })
    })
    render(<GsxRemotePanel />)
    await screen.findByText('Tap to open')

    servicesListener([
      {
        id: 'Refueling',
        displayName: 'Refuel',
        state: 'performing',
        stateText: 'Refueling service is being performed',
        icon: 'refueling',
        canTrigger: false,
        canBypass: false,
        operator: 'AFSC',
        statusText: 'pumping\nfuel 15357/81488 kg\naircraft 15606→30963 kg\nBill $24272',
        progressText: '19%',
        detail: {
          phase: 'pumping',
          fuel: { current: 15357, target: 81488, unit: 'kg', startTotal: 15606, aircraftTotal: 30963 },
          bill: 24272
        }
      }
    ])

    expect(await screen.findByText('15,357 / 81,488 kg')).toBeInTheDocument()
    expect(screen.getByText(/24,272/)).toBeInTheDocument()
    expect(screen.queryByText(/pumping\\nfuel/)).not.toBeInTheDocument()
  })

  it('shows formatted boarding pax/cargo progress instead of raw statusText', async () => {
    let servicesListener: (services: GsxRemoteServiceStatus[]) => void = () => {}
    withWinglog({
      onGsxRemoteServices: vi.fn((listener) => {
        servicesListener = listener
        return () => {}
      })
    })
    render(<GsxRemotePanel />)
    await screen.findByText('Tap to open')

    servicesListener([
      {
        id: 'Boarding',
        displayName: 'Board',
        state: 'requested',
        stateText: 'Boarding service has been requested',
        icon: 'boarding',
        canTrigger: false,
        canBypass: false,
        statusText: 'approaching\npax 0/344\nfront hold 0/7 ULDs (train 1 of 2, idle)',
        progressText: '344/344',
        detail: {
          phase: 'approaching',
          pax: { done: 0, total: 344 },
          cargo: [
            { hold: 'front', unit: 'ULDs', done: 0, total: 7, trip: 1, trips: 2, train: 'idle' },
            { hold: 'rear', unit: 'ULDs', done: 0, total: 6, trip: 1, trips: 2, train: 'idle' }
          ]
        }
      }
    ])

    expect(await screen.findByText('0 / 344')).toBeInTheDocument()
    expect(screen.getByText('Front: 0 / 7 ULDs')).toBeInTheDocument()
    expect(screen.getByText('Rear: 0 / 6 ULDs')).toBeInTheDocument()
  })

  const COMMAND_BAR = {
    commands: [
      { id: 'CUSTOMIZE_AIRPORT_POSITION' as const, label: 'Customize Airport', iconUri: null, confirm: false },
      { id: 'CUSTOMIZE_AIRPLANE' as const, label: 'Customize Aircraft', iconUri: null, confirm: false },
      { id: 'RESTART_COUATL' as const, label: 'Restart Couatl', iconUri: null, confirm: true }
    ],
    simbrief: { status: 'loaded', error: '', gen: 3 },
    simbriefIconUri: null
  }

  it('renders the command bar and runs a plain command on the first tap', async () => {
    const gsxRemoteRunCommand = vi.fn().mockResolvedValue(undefined)
    withWinglog({ gsxRemoteGetCommandBar: vi.fn().mockResolvedValue(COMMAND_BAR), gsxRemoteRunCommand })
    render(<GsxRemotePanel />)
    const user = userEvent.setup()

    expect(await screen.findByText('Customize Airport')).toBeInTheDocument()
    expect(screen.getByText('Customize Aircraft')).toBeInTheDocument()

    await user.click(screen.getByText('Customize Airport'))
    expect(gsxRemoteRunCommand).toHaveBeenCalledWith('CUSTOMIZE_AIRPORT_POSITION')
  })

  it('requires a second tap to confirm before running Restart Couatl', async () => {
    const gsxRemoteRunCommand = vi.fn().mockResolvedValue(undefined)
    withWinglog({ gsxRemoteGetCommandBar: vi.fn().mockResolvedValue(COMMAND_BAR), gsxRemoteRunCommand })
    render(<GsxRemotePanel />)
    const user = userEvent.setup()
    await screen.findByText('Restart Couatl')

    await user.click(screen.getByText('Restart Couatl'))
    expect(gsxRemoteRunCommand).not.toHaveBeenCalled()
    // GSX's own client text (menu.js), shown in place of the label while armed.
    expect(await screen.findByText('Confirm restart?')).toBeInTheDocument()

    await user.click(screen.getByText('Confirm restart?'))
    expect(gsxRemoteRunCommand).toHaveBeenCalledWith('RESTART_COUATL')
  })

  it('shows the SimBrief reload button with its real status sub-text, and an optimistic "Downloading..." until GSX bumps gen', async () => {
    let commandBarListener: (commandBar: typeof COMMAND_BAR) => void = () => {}
    const gsxRemoteRunCommand = vi.fn().mockResolvedValue(undefined)
    withWinglog({
      gsxRemoteGetCommandBar: vi.fn().mockResolvedValue(COMMAND_BAR),
      onGsxRemoteCommandBar: vi.fn((listener) => {
        commandBarListener = listener
        return () => {}
      }),
      gsxRemoteRunCommand
    })
    render(<GsxRemotePanel />)
    const user = userEvent.setup()

    expect(await screen.findByText('Reload SimBrief')).toBeInTheDocument()
    expect(screen.getByText('Plan loaded')).toBeInTheDocument()

    await user.click(screen.getByText('Reload SimBrief'))
    expect(gsxRemoteRunCommand).toHaveBeenCalledWith('RELOAD_SIMBRIEF')
    expect(await screen.findByText('Downloading...')).toBeInTheDocument()

    // A live push with the same gen (3) doesn't clear it — only a genuinely bumped gen does,
    // mirroring menu.js's own simbriefBtn() check exactly.
    commandBarListener({ ...COMMAND_BAR, simbrief: { status: 'loaded', error: '', gen: 3 } })
    expect(screen.getByText('Downloading...')).toBeInTheDocument()

    commandBarListener({ ...COMMAND_BAR, simbrief: { status: 'loaded', error: '', gen: 4 } })
    expect(await screen.findByText('Plan loaded')).toBeInTheDocument()
  })

  it('renders nothing for the command bar when GSX has no commands or simbrief state at all', async () => {
    withWinglog({ gsxRemoteGetCommandBar: vi.fn().mockResolvedValue({ commands: [], simbrief: null, simbriefIconUri: null }) })
    render(<GsxRemotePanel />)
    await screen.findByText('Tap to open')

    expect(screen.queryByText('Restart Couatl')).not.toBeInTheDocument()
    expect(screen.queryByText('Reload SimBrief')).not.toBeInTheDocument()
  })
})
