import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OnlineNetworkSettings } from '@shared/ipc'
import { PrefileButtons } from './PrefileButtons'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

function setup(settings: OnlineNetworkSettings) {
  window.winglog = {
    settingsGetOnlineNetwork: vi.fn(() => Promise.resolve(settings)),
    appLogRendererError: vi.fn(() => Promise.resolve())
  } as unknown as typeof window.winglog
}

const NONE: OnlineNetworkSettings = {
  network: null,
  vatsimCid: null,
  ivaoVid: null,
  keepBeyondAtcOnline: false,
  simTrafficButton: true
}

describe('PrefileButtons', () => {
  beforeEach(() => toastError.mockClear())

  it('shows no button while no network is chosen, once the setting is read', async () => {
    setup(NONE)
    const { container } = render(<PrefileButtons file={() => Promise.resolve(true)} />)
    await act(() => Promise.resolve())
    expect(window.winglog.settingsGetOnlineNetwork).toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['vatsim', 'File on VATSIM', 'File on IVAO'],
    ['ivao', 'File on IVAO', 'File on VATSIM']
  ] as const)('shows only the chosen network’s button for %s', async (network, shown, hidden) => {
    setup({ ...NONE, network })
    render(<PrefileButtons file={() => Promise.resolve(true)} />)
    expect(await screen.findByRole('button', { name: shown })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: hidden })).not.toBeInTheDocument()
  })

  it('shows nothing until the setting is read', () => {
    setup(NONE)
    const { container } = render(<PrefileButtons file={() => Promise.resolve(true)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('asks for the network clicked, and says nothing more when it opened', async () => {
    setup({ ...NONE, network: 'ivao' })
    const file = vi.fn(() => Promise.resolve(true))
    render(<PrefileButtons file={file} />)
    await userEvent.click(await screen.findByRole('button', { name: 'File on IVAO' }))
    expect(file).toHaveBeenCalledWith('ivao')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('says there is no filing link when the OFP had none', async () => {
    setup({ ...NONE, network: 'vatsim' })
    render(<PrefileButtons file={() => Promise.resolve(false)} />)
    await userEvent.click(await screen.findByRole('button', { name: 'File on VATSIM' }))
    expect(toastError).toHaveBeenCalledWith('This plan has no VATSIM filing link.')
  })
})
