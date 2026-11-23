import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppCapabilities, HostLinkStatus, LanDeviceKind, LanSettings, LanStatus } from '@shared/ipc'
import { CapabilitiesProvider } from '../app/capabilities'
import { DevicesPage } from './DevicesPage'
import { QrCode } from './QrCode'

const HOST: AppCapabilities = { runMode: 'host', canHostSim: true, multiDevice: true }
const MAC: AppCapabilities = { runMode: 'client', canHostSim: false, multiDevice: true }
const RELEASE: AppCapabilities = { runMode: 'host', canHostSim: true, multiDevice: false }

const BASE: LanStatus = {
  settings: { enabled: true, port: 5051, twinEnabled: true },
  listening: true,
  url: 'http://192.168.1.20:5051/',
  problem: null,
  connections: 0,
  pairing: null,
  twinPairing: null,
  twinCertificate: 'p'.repeat(43),
  devices: [{ id: 1, kind: 'screen', name: 'iPad', createdAt: 'x', lastSeenAt: null, connected: false }]
}

const UNPAIRED: HostLinkStatus = {
  state: 'unpaired',
  address: null,
  hostSim: null,
  sync: { state: 'idle', lastSyncedAt: null, problem: null }
}

/**
 * A sim PC as the page sees it: its status, the calls that change it, and what a device does on the other side.
 *
 * @param options The capabilities, the first status, how long a code lasts, and the client's link.
 * @returns The mocks and the device's actions.
 */
function setup(
  options: { capabilities?: AppCapabilities; lan?: LanStatus; codeMs?: number; link?: HostLinkStatus } = {}
) {
  let lan = options.lan ?? BASE
  let issued = 100_000
  const linkListeners: ((status: HostLinkStatus) => void)[] = []
  const field = (kind: LanDeviceKind | undefined): 'pairing' | 'twinPairing' =>
    kind === 'twin' ? 'twinPairing' : 'pairing'
  const api = {
    appGetCapabilities: vi.fn(() => Promise.resolve(options.capabilities ?? HOST)),
    // A code that has run out is no longer shown, as the PC does.
    lanGetStatus: vi.fn(() => {
      const live = (p: LanStatus['pairing']) => (p && Date.now() < p.expiresAt ? p : null)
      return Promise.resolve({ ...lan, pairing: live(lan.pairing), twinPairing: live(lan.twinPairing) })
    }),
    lanSetSettings: vi.fn((patch: Partial<LanSettings>) => {
      lan = { ...lan, settings: { ...lan.settings, ...patch } }
      return Promise.resolve(lan)
    }),
    lanStartPairing: vi.fn((kind?: LanDeviceKind) => {
      issued += 1
      lan = {
        ...lan,
        [field(kind)]: { code: String(issued), expiresAt: Date.now() + (options.codeMs ?? 300_000) }
      }
      return Promise.resolve(lan)
    }),
    lanStopPairing: vi.fn((kind?: LanDeviceKind) => {
      lan = { ...lan, [field(kind)]: null }
      return Promise.resolve(lan)
    }),
    lanRevokeDevice: vi.fn(() => Promise.resolve(lan)),
    settingsUseAnotherPcSim: vi.fn(() => Promise.resolve()),
    appRestartForRunMode: vi.fn(() => Promise.resolve()),
    hostLinkGetStatus: vi.fn(() => Promise.resolve(options.link ?? UNPAIRED)),
    hostLinkPair: vi.fn(() => Promise.resolve(options.link ?? UNPAIRED)),
    hostLinkForget: vi.fn(() => Promise.resolve()),
    onHostLinkStatus: vi.fn((listener: (status: HostLinkStatus) => void) => {
      linkListeners.push(listener)
      return () => {}
    }),
    settingsGetRunMode: vi.fn(() => Promise.resolve(null)),
    settingsSetRunMode: vi.fn(() => Promise.resolve()),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return {
    api,
    /** A device types the code: it is paired, and that kind's code is used up. */
    pair: (kind: LanDeviceKind, name: string) => {
      lan = {
        ...lan,
        [field(kind)]: null,
        devices: [
          ...lan.devices,
          { id: lan.devices.length + 1, kind, name, createdAt: 'y', lastSeenAt: null, connected: true }
        ]
      }
    },
    /** The PC cancels the phone's code after wrong guesses: nobody paired. */
    cancel: () => {
      lan = { ...lan, pairing: null }
    },
    pushLink: (status: HostLinkStatus) => act(() => linkListeners.forEach((listener) => listener(status)))
  }
}

function renderPage(): ReturnType<typeof render> {
  return render(
    <CapabilitiesProvider>
      <DevicesPage />
    </CapabilitiesProvider>
  )
}

/** Opens Add a device and returns the dialog. */
async function openAdd(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Add a device' }))
  return screen.findByRole('dialog')
}

describe('Add a device on the sim PC', () => {
  afterEach(() => vi.useRealTimers())

  it('asks what to add first, and closes with Escape without opening a code', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    renderPage()
    const dialog = await openAdd(user)
    expect(within(dialog).getByRole('heading', { name: 'Add a device' })).toBeInTheDocument()
    expect(within(dialog).getByText('What would you like to add?')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /A phone or tablet/ })).toHaveTextContent(
      'Shows the live map in its browser. Nothing to install.'
    )
    expect(within(dialog).getByRole('button', { name: /Another computer with WingLog/ })).toBeInTheDocument()
    expect(within(dialog).getByText('Only on your home network.')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.lanStartPairing).not.toHaveBeenCalled()
    expect(api.lanStopPairing).not.toHaveBeenCalled()
  })

  it('shows a phone the QR code and the code, waits for it, and closes the code on Close', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /A phone or tablet/ }))
    expect(await within(dialog).findByRole('heading', { name: 'Pair a phone or tablet' })).toBeInTheDocument()
    expect(api.lanStartPairing).toHaveBeenCalledWith('screen')
    expect(api.lanSetSettings).not.toHaveBeenCalled()
    // The QR code opens the page with the code already in it.
    const image = within(dialog).getByRole('img', { name: 'QR code for the second-screen address' })
    const expected = render(<QrCode text="http://192.168.1.20:5051/#code=100001" label="expected" />)
    expect(image.querySelector('path')?.getAttribute('d')).toBe(
      expected.container.querySelector('path')?.getAttribute('d')
    )
    expected.unmount()
    expect(within(dialog).getByText('http://192.168.1.20:5051/')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('100001')).toBeInTheDocument()
    expect(within(dialog).getByText('It works once and closes after 5 minutes.')).toBeInTheDocument()
    const waiting = within(dialog).getByText('Waiting for the device')
    expect(waiting.querySelector('[data-slot="status-light"]')).toHaveAttribute('data-state', 'amber')
    expect(within(dialog).queryByText('Phones and tablets are now on.')).not.toBeInTheDocument()
    // The step's own Close, not the corner button.
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement)
    expect(api.lanStopPairing).toHaveBeenCalledWith('screen')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('turns phones on when they were off, and says so (D1)', async () => {
    const user = userEvent.setup()
    const { api } = setup({ lan: { ...BASE, settings: { ...BASE.settings, enabled: false } } })
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /A phone or tablet/ }))
    expect(await within(dialog).findByText('Phones and tablets are now on.')).toBeInTheDocument()
    expect(api.lanSetSettings).toHaveBeenCalledWith({ enabled: true })
    expect(api.lanSetSettings.mock.invocationCallOrder[0]).toBeLessThan(
      api.lanStartPairing.mock.invocationCallOrder[0] as number
    )
  })

  it('moves to the success step when the phone pairs, and Done closes it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { api, pair } = setup()
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /A phone or tablet/ }))
    await within(dialog).findByLabelText('100001')
    pair('screen', 'iPhone')
    await act(() => vi.advanceTimersByTimeAsync(2100))
    const done = await within(dialog).findByText('iPhone is paired')
    // The success step keeps the step's title.
    expect(within(dialog).getByRole('heading', { name: 'Pair a phone or tablet' })).toBeInTheDocument()
    expect(done.querySelector('[data-slot="status-light"]')).toHaveAttribute('data-state', 'green')
    expect(api.lanStopPairing).toHaveBeenCalledWith('screen')
    // The used code is not replaced by a new one.
    expect(api.lanStartPairing).toHaveBeenCalledTimes(1)
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('opens a new phone code when the one on screen runs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { api } = setup({ codeMs: 3000 })
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /A phone or tablet/ }))
    await within(dialog).findByLabelText('100001')
    await act(() => vi.advanceTimersByTimeAsync(6300))
    await vi.waitFor(() => expect(api.lanStartPairing.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('does not reopen a phone code the PC cancelled after wrong guesses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { api, cancel } = setup()
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /A phone or tablet/ }))
    await within(dialog).findByLabelText('100001')
    cancel()
    await act(() => vi.advanceTimersByTimeAsync(8400))
    expect(api.lanStartPairing).toHaveBeenCalledTimes(1)
    expect(within(dialog).queryByText('Waiting for the device')).not.toBeInTheDocument()
    // It says the code has closed, and New code opens another.
    expect(within(dialog).getByText('This code has closed.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'New code' }))
    expect(await within(dialog).findByLabelText('100002')).toBeInTheDocument()
    expect(within(dialog).queryByText('This code has closed.')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Waiting for the device')).toBeInTheDocument()
  })

  it('does not renew a computer’s code: when it runs out the step says so and offers New code', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { api } = setup({ codeMs: 3000 })
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /Another computer with WingLog/ }))
    await within(dialog).findByLabelText('100001')
    await act(() => vi.advanceTimersByTimeAsync(6300))
    expect(await within(dialog).findByText('This code has closed.')).toBeInTheDocument()
    expect(api.lanStartPairing).toHaveBeenCalledTimes(1)
    expect(within(dialog).queryByLabelText('100001')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'New code' }))
    expect(api.lanStartPairing).toHaveBeenLastCalledWith('twin')
    expect(await within(dialog).findByLabelText('100002')).toBeInTheDocument()
  })

  it('closes a code that opens after the dialog was closed, so none is left open', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    let finish: (status: LanStatus) => void = () => {}
    const first = api.lanStartPairing.getMockImplementation()
    api.lanStartPairing.mockImplementationOnce(
      (kind?: LanDeviceKind) =>
        new Promise<LanStatus>((resolve) => {
          finish = (status) => resolve(status)
          void first?.(kind)
        })
    )
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /A phone or tablet/ }))
    await waitFor(() => expect(api.lanStartPairing).toHaveBeenCalled())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await act(async () => finish(await api.lanGetStatus()))
    await waitFor(() => expect(api.lanStopPairing).toHaveBeenCalledWith('screen'))
  })

  it('shows another computer the address and code, turning Computers on, and says when it has paired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { api, pair } = setup({ lan: { ...BASE, settings: { ...BASE.settings, twinEnabled: false } } })
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /Another computer with WingLog/ }))
    expect(await within(dialog).findByRole('heading', { name: 'Pair another computer' })).toBeInTheDocument()
    expect(api.lanSetSettings).toHaveBeenCalledWith({ twinEnabled: true })
    expect(api.lanStartPairing).toHaveBeenCalledWith('twin')
    expect(within(dialog).getByText('Computers are now on.')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        /^On the other computer, open WingLog, then Settings → Devices, and choose “Add a device”. On a Windows PC, choose “Use another PC’s sim” first/
      )
    ).toBeInTheDocument()
    expect(within(dialog).getByText('192.168.1.20:5051')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('100001')).toBeInTheDocument()
    expect(within(dialog).getByText('Waiting for the computer')).toBeInTheDocument()
    // A phone pairing meanwhile is not the computer.
    pair('screen', 'iPhone')
    await act(() => vi.advanceTimersByTimeAsync(2100))
    expect(within(dialog).queryByText('iPhone is paired')).not.toBeInTheDocument()
    pair('twin', 'MacBook Air')
    await act(() => vi.advanceTimersByTimeAsync(2100))
    expect(await within(dialog).findByText('MacBook Air is paired')).toBeInTheDocument()
    expect(api.lanStopPairing).toHaveBeenCalledWith('twin')
  })

  it('says why there is no code for computers when this PC cannot keep its certificate', async () => {
    const user = userEvent.setup()
    setup({ lan: { ...BASE, twinCertificate: null } })
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /Another computer with WingLog/ }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/security certificate/)
    expect(within(dialog).queryByText('Waiting for the computer')).not.toBeInTheDocument()
  })

  it.each([
    [{ problem: 'port-in-use' as const }, 'That port is already in use. Choose another.'],
    [{ url: null, listening: false }, 'Not reachable on your home network.']
  ])('says why there is no code for a phone when the PC cannot listen: %o', async (patch, line) => {
    const user = userEvent.setup()
    setup({ lan: { ...BASE, ...patch } })
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /A phone or tablet/ }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(line)
    expect(within(dialog).queryByText('Waiting for the device')).not.toBeInTheDocument()
  })

  it('closes the open code when the dialog is closed with Escape', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    renderPage()
    const dialog = await openAdd(user)
    await user.click(within(dialog).getByRole('button', { name: /Another computer with WingLog/ }))
    await within(dialog).findByLabelText('100001')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.lanStopPairing).toHaveBeenCalledWith('twin')
  })

  it('offers Use another PC’s sim on a sim PC: the next start is a client, and Restart now starts again', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    renderPage()
    const dialog = await openAdd(user)
    const choice = within(dialog).getByRole('button', { name: /Use another PC’s sim/ })
    expect(choice).toHaveTextContent('This PC stops running the sim and works with the sim on another PC.')
    await user.click(choice)
    expect(api.settingsUseAnotherPcSim).toHaveBeenCalled()
    expect(
      await within(dialog).findByText(/^WingLog needs to restart to use another PC’s sim/)
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('heading', { name: 'Use another PC’s sim' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Restart now' }))
    expect(api.appRestartForRunMode).toHaveBeenCalled()
    expect(api.lanStartPairing).not.toHaveBeenCalled()
  })

  it('offers no Use another PC’s sim on a computer that cannot run the sim', async () => {
    const user = userEvent.setup()
    setup({ capabilities: { runMode: 'host', canHostSim: false, multiDevice: true } })
    renderPage()
    const dialog = await openAdd(user)
    await within(dialog).findByRole('button', { name: /A phone or tablet/ })
    expect(within(dialog).queryByRole('button', { name: /Use another PC’s sim/ })).not.toBeInTheDocument()
  })

  it('opens straight on the phone step in a build with phones only', async () => {
    const user = userEvent.setup()
    const { api } = setup({ capabilities: RELEASE })
    renderPage()
    await screen.findByText('Phones and tablets that show this PC’s flight. Each one is paired once.')
    const dialog = await openAdd(user)
    expect(await within(dialog).findByRole('heading', { name: 'Pair a phone or tablet' })).toBeInTheDocument()
    expect(within(dialog).queryByText('What would you like to add?')).not.toBeInTheDocument()
    expect(api.lanStartPairing).toHaveBeenCalledWith('screen')
  })
})

describe('Add a device on a client: Connect to a sim PC', () => {
  it('connects with the address and code typed, then says it is connected, and Done closes it', async () => {
    const user = userEvent.setup()
    const { api, pushLink } = setup({ capabilities: MAC })
    renderPage()
    const dialog = await openAdd(user)
    expect(within(dialog).getByRole('heading', { name: 'Connect to a sim PC' })).toBeInTheDocument()
    expect(
      within(dialog).getByText('On the sim PC, choose “Add a device”, then “Another computer with WingLog”.')
    ).toBeInTheDocument()
    const connect = within(dialog).getByRole('button', { name: 'Connect' })
    expect(connect).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox', { name: 'Address' }), '192.168.1.20:5051')
    await user.type(within(dialog).getByRole('textbox', { name: 'Pairing code' }), '716204')
    await user.click(connect)
    expect(api.hostLinkPair).toHaveBeenCalledWith('192.168.1.20:5051', '716204')
    pushLink({ ...UNPAIRED, state: 'connecting', address: '192.168.1.20:5051' })
    expect(await within(dialog).findByText('Connecting…')).toBeInTheDocument()
    pushLink({ ...UNPAIRED, state: 'connected', address: '192.168.1.20:5051', hostSim: 'connected' })
    const done = await within(dialog).findByText('Connected to the sim PC')
    expect(done.querySelector('[data-slot="status-light"]')).toHaveAttribute('data-state', 'green')
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Paired now, so the page offers no Add a device.
    expect(screen.queryByRole('button', { name: 'Add a device' })).not.toBeInTheDocument()
  })

  it('says what is wrong with an address the app refuses, and says a wrong code in words', async () => {
    const user = userEvent.setup()
    const { api, pushLink } = setup({ capabilities: MAC })
    api.hostLinkPair.mockRejectedValueOnce(new Error('address'))
    renderPage()
    const dialog = await openAdd(user)
    await user.type(within(dialog).getByRole('textbox', { name: 'Address' }), 'example.com:5051')
    await user.type(within(dialog).getByRole('textbox', { name: 'Pairing code' }), '123456')
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))
    expect(await within(dialog).findByText(/^Enter the sim PC’s address with its port/)).toBeInTheDocument()
    await user.clear(within(dialog).getByRole('textbox', { name: 'Address' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Address' }), '192.168.1.20:5051')
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(within(dialog).queryByText(/^Enter the sim PC’s address/)).not.toBeInTheDocument()
    )
    pushLink({ ...UNPAIRED, state: 'wrong-code', address: '192.168.1.20:5051' })
    const wrong = await within(dialog).findByText('Wrong code')
    expect(wrong.querySelector('[data-slot="status-light"]')).toHaveAttribute('data-state', 'red')
  })

  it.each(['pair-again', 'certificate-changed', 'wrong-code'] as const)(
    'offers Add a device again when the link is %s',
    async (state) => {
      setup({ capabilities: MAC, link: { ...UNPAIRED, state, address: '192.168.1.20:5051' } })
      renderPage()
      expect(await screen.findByRole('button', { name: 'Add a device' })).toBeInTheDocument()
    }
  )

  it('offers no Add a device while the sim PC is paired and the link works or is reconnecting', async () => {
    setup({ capabilities: MAC, link: { ...UNPAIRED, state: 'offline', address: '192.168.1.20:5051' } })
    renderPage()
    await screen.findByText('192.168.1.20:5051')
    expect(screen.queryByRole('button', { name: 'Add a device' })).not.toBeInTheDocument()
  })
})
