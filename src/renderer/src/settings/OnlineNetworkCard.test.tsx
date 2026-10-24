import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OnlineNetworkSettings } from '@shared/ipc'
import { OnlineNetworkCard } from './OnlineNetworkCard'

function setup(initial: OnlineNetworkSettings) {
  const api = {
    settingsGetOnlineNetwork: vi.fn(() => Promise.resolve(initial)),
    settingsSetOnlineNetwork: vi.fn(() => Promise.resolve()),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return api
}

const NONE: OnlineNetworkSettings = { network: null, vatsimCid: null, ivaoVid: null }

describe('OnlineNetworkCard', () => {
  it('starts on None with no member number field', async () => {
    setup(NONE)
    render(<OnlineNetworkCard />)
    expect(await screen.findByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('chooses VATSIM and saves it at once, then asks for the CID', async () => {
    const api = setup(NONE)
    render(<OnlineNetworkCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'VATSIM' }))
    expect(api.settingsSetOnlineNetwork).toHaveBeenCalledWith({
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null
    })
    expect(screen.getByText('CID')).toBeInTheDocument()
    expect(screen.queryByText(/IVAO shows other pilots/)).not.toBeInTheDocument()
  })

  it('chooses IVAO and says why it needs the VID', async () => {
    setup(NONE)
    render(<OnlineNetworkCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'IVAO' }))
    expect(screen.getByText('VID')).toBeInTheDocument()
    expect(screen.getByText(/IVAO shows other pilots only to its members/)).toBeInTheDocument()
  })

  it('keeps only digits, at most ten, and saves the number when the field loses focus', async () => {
    const api = setup({ network: 'ivao', vatsimCid: null, ivaoVid: null })
    render(<OnlineNetworkCard />)
    const field = await screen.findByRole('textbox')
    await userEvent.type(field, '90a0-0 1234567890')
    expect(field).toHaveValue('9000123456')
    expect(api.settingsSetOnlineNetwork).not.toHaveBeenCalled()
    await userEvent.tab()
    expect(api.settingsSetOnlineNetwork).toHaveBeenCalledWith({
      network: 'ivao',
      vatsimCid: null,
      ivaoVid: '9000123456'
    })
  })

  it('saves on Enter, and not again when nothing changed', async () => {
    const api = setup({ network: 'vatsim', vatsimCid: '1234567', ivaoVid: null })
    render(<OnlineNetworkCard />)
    const field = await screen.findByRole('textbox')
    expect(field).toHaveValue('1234567')
    await userEvent.type(field, '8{Enter}')
    expect(api.settingsSetOnlineNetwork).toHaveBeenCalledTimes(1)
    expect(api.settingsSetOnlineNetwork).toHaveBeenCalledWith({
      network: 'vatsim',
      vatsimCid: '12345678',
      ivaoVid: null
    })
    await userEvent.click(field)
    await userEvent.tab()
    expect(api.settingsSetOnlineNetwork).toHaveBeenCalledTimes(1)
  })

  it('clears a number that is emptied, saving null', async () => {
    const api = setup({ network: 'vatsim', vatsimCid: '42', ivaoVid: null })
    render(<OnlineNetworkCard />)
    await userEvent.clear(await screen.findByRole('textbox'))
    await userEvent.tab()
    expect(api.settingsSetOnlineNetwork).toHaveBeenCalledWith({
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null
    })
  })

  it('shows each network its own number, and keeps the other', async () => {
    setup({ network: 'vatsim', vatsimCid: '111', ivaoVid: '222' })
    render(<OnlineNetworkCard />)
    expect(await screen.findByRole('textbox')).toHaveValue('111')
    await userEvent.click(screen.getByRole('button', { name: 'IVAO' }))
    expect(screen.getByRole('textbox')).toHaveValue('222')
  })

  it('goes back to None and hides the field', async () => {
    const api = setup({ network: 'vatsim', vatsimCid: '111', ivaoVid: null })
    render(<OnlineNetworkCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'None' }))
    expect(api.settingsSetOnlineNetwork).toHaveBeenCalledWith({
      network: null,
      vatsimCid: '111',
      ivaoVid: null
    })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
