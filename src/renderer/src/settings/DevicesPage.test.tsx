import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppCapabilities, HostLinkStatus, LanDevice, LanSettings, LanStatus } from '@shared/ipc'
import { CapabilitiesProvider } from '../app/capabilities'
import { DevicesPage } from './DevicesPage'

const HOST: AppCapabilities = { runMode: 'host', canHostSim: true, multiDevice: true }
const MAC: AppCapabilities = { runMode: 'client', canHostSim: false, multiDevice: true }
const RELEASE: AppCapabilities = { runMode: 'host', canHostSim: true, multiDevice: false }

/** Two days before the test runs: the iPad's last visit. */
const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 3600_000).toISOString()

const MAC_TWIN: LanDevice = {
  id: 1,
  kind: 'twin',
  name: 'MacBook Air',
  createdAt: '2026-11-20T10:00:00.000Z',
  lastSeenAt: '2026-11-23T09:00:00.000Z',
  connected: true
}
const IPAD: LanDevice = {
  id: 2,
  kind: 'screen',
  name: 'iPad',
  createdAt: '2026-11-21T10:00:00.000Z',
  lastSeenAt: TWO_DAYS_AGO,
  connected: false
}

const ON: LanStatus = {
  settings: { enabled: true, port: 5051, twinEnabled: true },
  listening: true,
  url: 'http://192.168.1.20:5051/',
  problem: null,
  connections: 1,
  pairing: null,
  twinPairing: null,
  twinCertificate: 'p'.repeat(43),
  devices: [MAC_TWIN, IPAD]
}

const CONNECTED: HostLinkStatus = {
  state: 'connected',
  address: '192.168.1.20:5051',
  hostSim: 'connected',
  sync: { state: 'idle', lastSyncedAt: null, problem: null }
}

/** Installs a window.winglog for the page, answering from the statuses given, and returns the mocks. */
function setup(options: { capabilities?: AppCapabilities; lan?: LanStatus; link?: HostLinkStatus } = {}) {
  let lan = options.lan ?? ON
  let pushLink: (status: HostLinkStatus) => void = () => {}
  const api = {
    appGetCapabilities: vi.fn(() => Promise.resolve(options.capabilities ?? HOST)),
    lanGetStatus: vi.fn(() => Promise.resolve(lan)),
    lanSetSettings: vi.fn((patch: Partial<LanSettings>) => {
      lan = { ...lan, settings: { ...lan.settings, ...patch } }
      return Promise.resolve(lan)
    }),
    lanRenameDevice: vi.fn((id: number, name: string) => {
      lan = {
        ...lan,
        devices: lan.devices.map((device) => (device.id === id ? { ...device, name } : device))
      }
      return Promise.resolve(lan)
    }),
    lanRevokeDevice: vi.fn((id: number) => {
      lan = { ...lan, devices: lan.devices.filter((device) => device.id !== id) }
      return Promise.resolve(lan)
    }),
    hostLinkGetStatus: vi.fn(() => Promise.resolve(options.link ?? CONNECTED)),
    hostLinkForget: vi.fn(() => Promise.resolve()),
    onHostLinkStatus: vi.fn((listener: (status: HostLinkStatus) => void) => {
      pushLink = listener
      return () => {}
    }),
    settingsGetRunMode: vi.fn(() => Promise.resolve(null)),
    settingsSetRunMode: vi.fn(() => Promise.resolve()),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return { api, pushLink: (status: HostLinkStatus) => act(() => pushLink(status)) }
}

function renderPage(): ReturnType<typeof render> {
  return render(
    <CapabilitiesProvider>
      <DevicesPage />
    </CapabilitiesProvider>
  )
}

/** The section headed by a title, once it shows. */
async function section(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title })
  return heading.closest('section') as HTMLElement
}

/** A device's row in the list: the line holding its name. */
function rowOf(name: string): HTMLElement {
  return screen.getByText(name).parentElement?.parentElement as HTMLElement
}

describe('DevicesPage on the sim PC', () => {
  afterEach(() => vi.useRealTimers())

  it('lists the twins and phones together: a connected computer is green, a phone not seen for two days is a ring', async () => {
    setup()
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Devices' })).toBeInTheDocument()
    expect(
      screen.getByText('Other computers and phones that use this PC’s sim. Each one is paired once.')
    ).toBeInTheDocument()
    await screen.findByText('MacBook Air')
    const mac = rowOf('MacBook Air')
    expect(within(mac).getByText('Computer')).toBeInTheDocument()
    expect(within(mac).getByText('Connected')).toBeInTheDocument()
    expect(mac.querySelector('[data-slot="status-light"]')).toHaveAttribute('data-state', 'green')
    const ipad = rowOf('iPad')
    expect(within(ipad).getByText('Phone or tablet')).toBeInTheDocument()
    expect(within(ipad).getByText(`Last seen ${new Date(TWO_DAYS_AGO).toLocaleString()}`)).toBeInTheDocument()
    const ring = ipad.querySelector('[data-slot="status-light"]')
    expect(ring).toHaveAttribute('data-state', 'off')
    expect(ring?.firstElementChild).toHaveClass('bg-transparent')
    // In the order they paired.
    const names = within(await section('Paired with this PC'))
      .getAllByText(/^(MacBook Air|iPad)$/)
      .map((element) => element.textContent)
    expect(names).toEqual(['MacBook Air', 'iPad'])
  })

  it('says when nothing is paired', async () => {
    setup({ lan: { ...ON, devices: [] } })
    renderPage()
    expect(await screen.findByText('Nothing paired yet.')).toBeInTheDocument()
  })

  it('says a device never connected', async () => {
    setup({ lan: { ...ON, devices: [{ ...IPAD, lastSeenAt: null }] } })
    renderPage()
    expect(await screen.findByText('Never connected')).toBeInTheDocument()
  })

  it('asks before it removes a device, and removes it only on Remove', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Remove iPad' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Remove iPad?')).toBeInTheDocument()
    expect(within(dialog).getByText('It will need to pair again.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.lanRevokeDevice).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove iPad' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }))
    expect(api.lanRevokeDevice).toHaveBeenCalledWith(2)
    await waitFor(() => expect(screen.queryByText('iPad')).not.toBeInTheDocument())
  })

  it('renames a device in the list: Rename, a new name, Enter', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Rename MacBook Air' }))
    const field = screen.getByRole('textbox', { name: 'Name' })
    expect(field).toHaveValue('MacBook Air')
    expect(field).toHaveFocus()
    await user.clear(field)
    await user.type(field, '  Callum’s MacBook {Enter}')
    expect(api.lanRenameDevice).toHaveBeenCalledWith(1, 'Callum’s MacBook')
    expect(await screen.findByText('Callum’s MacBook')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument()
  })

  it('saves a new name with Save too', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Rename iPad' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' mini')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.lanRenameDevice).toHaveBeenCalledWith(2, 'iPad mini')
  })

  it('sends nothing for Escape, Cancel, an empty name or the same name', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    renderPage()
    const rename = await screen.findByRole('button', { name: 'Rename iPad' })
    await user.click(rename)
    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' Pro{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument()
    expect(screen.getByText('iPad')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Rename iPad' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Rename iPad' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '   {Enter}')
    await user.click(screen.getByRole('button', { name: 'Rename iPad' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '{Enter}')
    expect(api.lanRenameDevice).not.toHaveBeenCalled()
    expect(screen.getByText('iPad')).toBeInTheDocument()
  })

  it('keeps a name to 40 characters', async () => {
    const user = userEvent.setup()
    setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Rename iPad' }))
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute('maxLength', '40')
  })

  it('saves each switch on its own, and the port, through lanSetSettings', async () => {
    const user = userEvent.setup()
    const { api } = setup({ lan: { ...ON, settings: { enabled: false, port: 5051, twinEnabled: false } } })
    renderPage()
    const computers = await screen.findByRole('group', { name: 'Computers' })
    await user.click(within(computers).getByRole('button', { name: 'On' }))
    expect(api.lanSetSettings).toHaveBeenLastCalledWith({ twinEnabled: true })
    const phones = screen.getByRole('group', { name: 'Phones and tablets' })
    await user.click(within(phones).getByRole('button', { name: 'On' }))
    expect(api.lanSetSettings).toHaveBeenLastCalledWith({ enabled: true })
    const port = await screen.findByRole('textbox', { name: 'Port' })
    await user.clear(port)
    await user.type(port, '5060')
    await user.tab()
    expect(api.lanSetSettings).toHaveBeenLastCalledWith({ port: 5060 })
  })

  it('puts a port that cannot be used back, and sends nothing', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    renderPage()
    const port = await screen.findByRole('textbox', { name: 'Port' })
    await user.clear(port)
    await user.type(port, '80')
    await user.tab()
    expect(port).toHaveValue('5051')
    expect(api.lanSetSettings).not.toHaveBeenCalled()
  })

  it('shows the address devices reach this PC on, read only, and the help line', async () => {
    setup()
    renderPage()
    expect(await screen.findByText('http://192.168.1.20:5051/')).toBeInTheDocument()
    expect(screen.getByText(/^Can’t connect\?/)).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('hides the port and address while both switches are off', async () => {
    setup({
      lan: {
        ...ON,
        settings: { enabled: false, port: 5051, twinEnabled: false },
        url: null,
        listening: false
      }
    })
    renderPage()
    await screen.findByRole('group', { name: 'Phones and tablets' })
    expect(screen.queryByRole('textbox', { name: 'Port' })).not.toBeInTheDocument()
  })

  it.each([
    [{ problem: 'port-in-use' as const }, 'That port is already in use. Choose another.'],
    [{ url: null, listening: false }, 'Not reachable on your home network.'],
    [
      { twinCertificate: null },
      'Other WingLogs can’t connect because this PC can’t store its security certificate safely.'
    ]
  ])('says why devices cannot connect: %o', async (patch, line) => {
    setup({ lan: { ...ON, ...patch } })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(line)
  })

  it('offers the run mode on a computer that can run the sim, and saves the choice', async () => {
    const user = userEvent.setup()
    const { api } = setup()
    renderPage()
    expect(await screen.findByRole('heading', { name: 'This computer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'This PC' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Takes effect the next time WingLog starts.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Another PC' }))
    expect(api.settingsSetRunMode).toHaveBeenCalledWith('client')
  })

  it('in a build without multi-device: phones and tablets only, no Computers switch and no run mode', async () => {
    setup({ capabilities: RELEASE, lan: { ...ON, devices: [IPAD] } })
    renderPage()
    expect(
      await screen.findByText('Phones and tablets that show this PC’s flight. Each one is paired once.')
    ).toBeInTheDocument()
    await screen.findByText('iPad')
    expect(screen.queryByRole('group', { name: 'Computers' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'This computer' })).not.toBeInTheDocument()
  })

  it('keeps the status current while open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { api } = setup()
    renderPage()
    await screen.findByText('MacBook Air')
    const before = api.lanGetStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(4100)
    expect(api.lanGetStatus.mock.calls.length).toBeGreaterThanOrEqual(before + 2)
  })
})

describe('DevicesPage on a client', () => {
  it('shows its sim PC as the one row, with its light, address and state, and Forget', async () => {
    const user = userEvent.setup()
    const { api } = setup({ capabilities: MAC })
    renderPage()
    expect(
      await screen.findByText(
        'This computer uses the sim on another PC. Its logbook and fleet are kept in step with that PC’s.'
      )
    ).toBeInTheDocument()
    const list = await section('Sim PC')
    expect(await within(list).findByText('192.168.1.20:5051')).toBeInTheDocument()
    expect(within(list).getByText('Connected')).toBeInTheDocument()
    expect(list.querySelector('[data-slot="status-light"]')).toHaveAttribute('data-state', 'green')
    expect(
      within(list).getByText(
        'Phones and tablets pair with the sim PC, not with this computer: on the sim PC, open Settings → Devices → Add a device.'
      )
    ).toBeInTheDocument()
    await user.click(within(list).getByRole('button', { name: 'Forget' }))
    expect(api.hostLinkForget).toHaveBeenCalled()
    // A client runs no server, so it has no network section.
    expect(screen.queryByRole('heading', { name: 'On your home network' })).not.toBeInTheDocument()
    // A Mac cannot run the sim, so it has no choice of where the sim runs.
    expect(screen.queryByRole('heading', { name: 'This computer' })).not.toBeInTheDocument()
  })

  it.each([
    ['connected', 'disconnected', 'Connected', 'amber'],
    ['offline', 'connected', 'Not reachable, trying again', 'red'],
    ['connecting', null, 'Connecting…', 'red'],
    ['wrong-code', null, 'Wrong code', 'red']
  ] as const)(
    'says the link is %s (its sim %s) in words and with the light',
    async (state, hostSim, words, light) => {
      setup({ capabilities: MAC, link: { ...CONNECTED, state, hostSim } })
      renderPage()
      const list = await section('Sim PC')
      expect(await within(list).findByText(words)).toBeInTheDocument()
      expect(list.querySelector('[data-slot="status-light"]')).toHaveAttribute('data-state', light)
    }
  )

  it.each([
    ['pair-again', /link to the sim PC is now encrypted\. Pair this computer again/],
    ['certificate-changed', /security certificate has changed since this computer paired/],
    ['not-secure', /did not answer with an encrypted connection/]
  ] as const)('says what happened and what to do when the link is %s', async (state, line) => {
    setup({ capabilities: MAC, link: { ...CONNECTED, state, hostSim: null } })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(line)
  })

  it('says which computer to update when the two run different versions of the sync', async () => {
    setup({
      capabilities: MAC,
      link: { ...CONNECTED, sync: { state: 'error', lastSyncedAt: null, problem: 'update-sim-pc' } }
    })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(/Update WingLog on the sim PC/)
  })

  it('says nothing is paired, with no Forget, before a sim PC is paired, and follows the link as it changes', async () => {
    const { pushLink } = setup({
      capabilities: MAC,
      link: { state: 'unpaired', address: null, hostSim: null, sync: CONNECTED.sync }
    })
    renderPage()
    expect(await screen.findByText('Nothing paired yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Forget' })).not.toBeInTheDocument()
    pushLink(CONNECTED)
    expect(await screen.findByText('192.168.1.20:5051')).toBeInTheDocument()
  })
})
