import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LanSettings, LanStatus } from '@shared/ipc'
import { TwinCard } from './TwinCard'

const OFF: LanStatus = {
  settings: { enabled: false, port: 8765, twinEnabled: false },
  listening: false,
  url: null,
  problem: null,
  connections: 0,
  pairing: null,
  twinPairing: null,
  devices: []
}

const ON: LanStatus = {
  ...OFF,
  settings: { enabled: false, port: 8765, twinEnabled: true },
  listening: true,
  url: 'http://192.168.1.136:8765/'
}

/** Installs a window.winglog whose second-screen calls answer from `status`, returning the mocks. */
function setup(status: LanStatus) {
  const api = {
    lanGetStatus: vi.fn(() => Promise.resolve(status)),
    lanSetSettings: vi.fn((settings: Partial<LanSettings>) =>
      Promise.resolve({ ...status, settings: { ...status.settings, ...settings } })
    ),
    lanStartPairing: vi.fn(() =>
      Promise.resolve({ ...status, twinPairing: { code: '482913', expiresAt: Date.now() + 300_000 } })
    ),
    lanStopPairing: vi.fn(() => Promise.resolve(status)),
    lanRevokeDevice: vi.fn(() => Promise.resolve({ ...status, devices: [] })),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return api
}

afterEach(() => vi.restoreAllMocks())

describe('TwinCard', () => {
  it('is off to begin with, and switching it on sends only its own switch', async () => {
    const api = setup(OFF)
    render(<TwinCard />)
    expect(await screen.findByRole('button', { name: /^Off$/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'Pair another WingLog' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^On$/ }))
    expect(api.lanSetSettings).toHaveBeenCalledWith({ twinEnabled: true })
  })

  it('shows the address a twin connects to, and opens its own pairing code on request', async () => {
    const api = setup(ON)
    render(<TwinCard />)
    expect(await screen.findByText('192.168.1.136:8765')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Pair another WingLog' }))
    expect(api.lanStartPairing).toHaveBeenCalledWith('twin')
    expect(await screen.findByLabelText('482913')).toBeInTheDocument()
  })

  it('copies the pairing text, which carries the address and the code in one line', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setup({ ...ON, twinPairing: { code: '482913', expiresAt: Date.now() + 300_000 } })
    render(<TwinCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Copy pairing text' }))
    expect(writeText).toHaveBeenCalledWith('winglog-pair://192.168.1.136:8765/482913')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('closes the code', async () => {
    const api = setup({ ...ON, twinPairing: { code: '482913', expiresAt: Date.now() + 300_000 } })
    render(<TwinCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect(api.lanStopPairing).toHaveBeenCalledWith('twin')
  })

  it('lists the paired WingLogs only, and revokes one', async () => {
    const api = setup({
      ...ON,
      devices: [
        { id: 1, kind: 'screen', name: 'iPad', createdAt: 'x', lastSeenAt: null },
        { id: 2, kind: 'twin', name: 'WingLog on MAC', createdAt: 'x', lastSeenAt: null }
      ]
    })
    render(<TwinCard />)
    expect(await screen.findByText('WingLog on MAC')).toBeInTheDocument()
    expect(screen.queryByText('iPad')).not.toBeInTheDocument()
    expect(screen.getByText('1 paired')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Revoke WingLog on MAC' }))
    expect(api.lanRevokeDevice).toHaveBeenCalledWith(2)
  })

  it('says so when the server cannot be reached on the home network', async () => {
    setup({ ...ON, listening: false, url: null, problem: 'no-adapter' })
    render(<TwinCard />)
    expect(await screen.findByText('Not reachable on your home network.')).toBeInTheDocument()
  })
})
