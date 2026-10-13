import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LanSettings, LanStatus } from '@shared/ipc'
import { LanCard } from './LanCard'
import { QrCode } from './QrCode'

const OFF: LanStatus = {
  settings: { enabled: false, port: 8765 },
  listening: false,
  url: null,
  problem: null,
  connections: 0,
  pairing: null,
  devices: []
}

const ON: LanStatus = {
  ...OFF,
  settings: { enabled: true, port: 8765 },
  listening: true,
  url: 'http://192.168.1.136:8765/'
}

/** Installs a window.winglog whose second-screen calls answer from `status`, returning the mocks. */
function setup(status: LanStatus) {
  const api = {
    lanGetStatus: vi.fn(() => Promise.resolve(status)),
    lanSetSettings: vi.fn((settings: LanSettings) => Promise.resolve({ ...status, settings })),
    lanStartPairing: vi.fn(() =>
      Promise.resolve({ ...status, pairing: { code: '482913', expiresAt: Date.now() + 300_000 } })
    ),
    lanStopPairing: vi.fn(() => Promise.resolve(status)),
    lanRevokeDevice: vi.fn(() => Promise.resolve({ ...status, devices: [] })),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return api
}

describe('LanCard', () => {
  afterEach(() => vi.useRealTimers())

  it('shows only the switch while the second screen is off, and turns it on', async () => {
    const api = setup(OFF)
    render(<LanCard />)
    expect(await screen.findByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Pair a device')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'On' }))
    expect(api.lanSetSettings).toHaveBeenCalledWith({ enabled: true, port: 8765 })
  })

  it('shows the address to open and how many devices are connected when it is listening', async () => {
    setup({ ...ON, connections: 2 })
    render(<LanCard />)
    expect(await screen.findByText('http://192.168.1.136:8765/')).toBeInTheDocument()
    expect(screen.getByText('2 devices connected now')).toBeInTheDocument()
  })

  it('keeps the QR code blurred and the pairing code hidden until Pair a device is pressed, and shows no QR code at all when it is not listening', async () => {
    setup(ON)
    const { unmount, container } = render(<LanCard />)
    await screen.findByText('http://192.168.1.136:8765/')
    // A blurred placeholder only: not an image a person or a scanner is offered, and no code on screen.
    expect(
      screen.queryByRole('img', { name: 'QR code for the second-screen address' })
    ).not.toBeInTheDocument()
    const placeholder = container.querySelector('svg')
    expect(placeholder).toHaveAttribute('aria-hidden', 'true')
    expect(placeholder).toHaveClass('blur-md')
    expect(screen.queryByLabelText('482913')).not.toBeInTheDocument()
    unmount()
    setup({ ...ON, listening: false, url: null, problem: 'port-in-use' })
    const off = render(<LanCard />)
    await screen.findByRole('alert')
    expect(off.container.querySelector('svg')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pair a device' })).not.toBeInTheDocument()
  })

  it('reveals a sharp QR code carrying the pairing code, and the code, when Pair a device is pressed, and hides them again on Close', async () => {
    setup(ON)
    render(<LanCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Pair a device' }))
    const image = await screen.findByRole('img', { name: 'QR code for the second-screen address' })
    expect(image).not.toHaveClass('blur-md')
    expect(screen.getByLabelText('482913')).toBeInTheDocument()
    expect(
      screen.getByText('Scan it with the phone to open the page and pair. The code changes every 5 minutes.')
    ).toBeInTheDocument()
    const expected = render(<QrCode text="http://192.168.1.136:8765/#code=482913" label="expected" />)
    expect(image.querySelector('path')?.getAttribute('d')).toBe(
      expected.container.querySelector('path')?.getAttribute('d')
    )
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await vi.waitFor(() =>
      expect(
        screen.queryByRole('img', { name: 'QR code for the second-screen address' })
      ).not.toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: 'Pair a device' })).toBeInTheDocument()
  })

  /**
   * A stand-in PC for the pairing code: it shows a code for as long as it is open, is spent when a device pairs, and opens a new one
   * when asked.
   *
   * @param api The mocked window.winglog calls.
   * @param lifetimeMs How long each code lasts.
   * @returns What a test can do to it.
   */
  function fakePc(api: ReturnType<typeof setup>, lifetimeMs: number) {
    const startPairing = api.lanStartPairing as ReturnType<typeof vi.fn>
    let devices = 0
    let open: { code: string; expiresAt: number } | null = null
    let issued = 0
    const status = (): LanStatus => ({
      ...ON,
      devices: Array.from({ length: devices }, (_, i) => ({
        id: i + 1,
        name: 'Phone',
        createdAt: 'x',
        lastSeenAt: null
      })),
      pairing: open && Date.now() < open.expiresAt ? open : null
    })
    api.lanGetStatus.mockImplementation(() => Promise.resolve(status()))
    startPairing.mockImplementation(() => {
      issued += 1
      open = { code: String(100000 + issued), expiresAt: Date.now() + lifetimeMs }
      return Promise.resolve(status())
    })
    api.lanStopPairing.mockImplementation(() => {
      open = null
      return Promise.resolve(status())
    })
    return {
      /** A device pairs with the open code: the code is spent. */
      pair: () => {
        devices += 1
        open = null
      },
      /** The PC cancels the code after wrong guesses: nobody paired. */
      cancel: () => {
        open = null
      }
    }
  }

  it('opens a new code when the one on screen is used, so a second device can follow, until Close', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = setup(ON)
    const pc = fakePc(api, 300_000)
    render(<LanCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Pair a device' }))
    expect(api.lanStartPairing).toHaveBeenCalledTimes(1)
    pc.pair()
    await vi.advanceTimersByTimeAsync(2100)
    await vi.waitFor(() => expect(api.lanStartPairing).toHaveBeenCalledTimes(2))
    expect(await screen.findByLabelText('100002')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    pc.pair()
    await vi.advanceTimersByTimeAsync(4200)
    expect(api.lanStartPairing).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('opens a new code when the one on screen runs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = setup(ON)
    fakePc(api, 3000)
    render(<LanCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Pair a device' }))
    await vi.advanceTimersByTimeAsync(6300)
    await vi.waitFor(() => expect(api.lanStartPairing.mock.calls.length).toBeGreaterThanOrEqual(2))
    vi.useRealTimers()
  })

  it('does not reopen a code the PC cancelled after wrong guesses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = setup(ON)
    const pc = fakePc(api, 300_000)
    render(<LanCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Pair a device' }))
    pc.cancel()
    await vi.advanceTimersByTimeAsync(8400)
    expect(api.lanStartPairing).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Pair a device' })).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('offers no choice of network: the PC picks its own home network', async () => {
    setup(ON)
    render(<LanCard />)
    await screen.findByText('http://192.168.1.136:8765/')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByText('Network')).not.toBeInTheDocument()
  })

  it('saves a new port when the field is left, and puts the old one back if it is not a usable port', async () => {
    const api = setup(ON)
    render(<LanCard />)
    const port = await screen.findByRole('textbox', { name: 'Port' })
    await userEvent.clear(port)
    await userEvent.type(port, '9100')
    await userEvent.tab()
    expect(api.lanSetSettings).toHaveBeenCalledWith({ enabled: true, port: 9100 })

    api.lanSetSettings.mockClear()
    await userEvent.clear(port)
    await userEvent.type(port, '80')
    await userEvent.tab()
    expect(api.lanSetSettings).not.toHaveBeenCalled()
    expect(port).toHaveValue('9100')
  })

  it('explains why it is not listening', async () => {
    setup({ ...ON, listening: false, url: null, problem: 'port-in-use' })
    render(<LanCard />)
    expect(await screen.findByRole('alert')).toHaveTextContent('That port is already in use. Choose another.')
    expect(screen.queryByText('Pair a device')).not.toBeInTheDocument()
  })

  it('opens pairing, shows the code, and closes it', async () => {
    const api = setup(ON)
    render(<LanCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Pair a device' }))
    expect(api.lanStartPairing).toHaveBeenCalled()
    expect(await screen.findByLabelText('482913')).toHaveTextContent('482913')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(api.lanStopPairing).toHaveBeenCalled()
  })

  it('lists paired devices and revokes one', async () => {
    const api = setup({
      ...ON,
      devices: [
        { id: 4, name: "Callum's iPad (Safari)", createdAt: '2026-10-12T10:00:00.000Z', lastSeenAt: null }
      ]
    })
    render(<LanCard />)
    expect(await screen.findByText("Callum's iPad (Safari)")).toBeInTheDocument()
    expect(screen.getByText('Never connected')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: "Revoke Callum's iPad (Safari)" }))
    expect(api.lanRevokeDevice).toHaveBeenCalledWith(4)
    expect(await screen.findByText('No devices paired yet.')).toBeInTheDocument()
  })

  it('shows when a paired device was last seen', async () => {
    setup({
      ...ON,
      devices: [
        {
          id: 1,
          name: 'Phone',
          createdAt: '2026-10-12T10:00:00.000Z',
          lastSeenAt: '2026-10-12T12:30:00.000Z'
        }
      ]
    })
    render(<LanCard />)
    expect(await screen.findByText(/^Last seen /)).toBeInTheDocument()
  })

  it('keeps the status current while open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = setup(ON)
    render(<LanCard />)
    await screen.findByText('http://192.168.1.136:8765/')
    const before = api.lanGetStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(4100)
    expect(api.lanGetStatus.mock.calls.length).toBeGreaterThanOrEqual(before + 2)
  })
})
