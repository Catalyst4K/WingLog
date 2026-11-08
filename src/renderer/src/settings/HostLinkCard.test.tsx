import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HostLinkStatus } from '@shared/ipc'
import { HostLinkCard } from './HostLinkCard'

function setup(
  initial: HostLinkStatus,
  pair: () => Promise<HostLinkStatus> = () => Promise.resolve(initial)
) {
  let push: (status: HostLinkStatus) => void = () => {}
  const api = {
    hostLinkGetStatus: vi.fn(() => Promise.resolve(initial)),
    hostLinkPair: vi.fn(pair),
    hostLinkForget: vi.fn(() => Promise.resolve()),
    onHostLinkStatus: vi.fn((listener: (status: HostLinkStatus) => void) => {
      push = listener
      return () => {}
    }),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return { api, push: (status: HostLinkStatus) => act(() => push(status)) }
}

const UNPAIRED: HostLinkStatus = { state: 'unpaired', address: null, hostSim: null }
const CONNECTED: HostLinkStatus = { state: 'connected', address: '192.168.1.20:5051', hostSim: 'connected' }

describe('HostLinkCard', () => {
  it('asks for the address and the code, and pairs with what was typed', async () => {
    const { api } = setup(UNPAIRED)
    render(<HostLinkCard />)
    const connect = await screen.findByRole('button', { name: 'Connect' })
    expect(connect).toBeDisabled()
    expect(screen.getByText('Not paired')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Address'), '192.168.1.20:5051')
    await userEvent.type(screen.getByLabelText('Pairing code'), '123456')
    await userEvent.click(connect)
    expect(api.hostLinkPair).toHaveBeenCalledWith('192.168.1.20:5051', '123456')
    expect(screen.getByLabelText('Pairing code')).toHaveValue('')
  })

  it('takes the host pairing text in one paste: the address and the code fill both fields', async () => {
    const { api } = setup(UNPAIRED)
    render(<HostLinkCard />)
    const address = await screen.findByLabelText('Address')
    await userEvent.click(address)
    await userEvent.paste('winglog-pair://192.168.1.20:5051/123456')
    expect(address).toHaveValue('192.168.1.20:5051')
    expect(screen.getByLabelText('Pairing code')).toHaveValue('123456')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(api.hostLinkPair).toHaveBeenCalledWith('192.168.1.20:5051', '123456')
  })

  it('says what is wrong with an address the app refuses', async () => {
    setup(UNPAIRED, () => Promise.reject(new Error('Enter the sim PC’s address with its port')))
    render(<HostLinkCard />)
    await userEvent.type(await screen.findByLabelText('Address'), 'example.com:5051')
    await userEvent.type(screen.getByLabelText('Pairing code'), '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText(/address on your home network/)).toBeInTheDocument()
  })

  it('shows the sim PC it is paired with and can forget it', async () => {
    const { api } = setup(CONNECTED)
    render(<HostLinkCard />)
    expect(await screen.findByText('Paired with 192.168.1.20:5051')).toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.queryByLabelText('Address')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Forget this sim PC' }))
    expect(api.hostLinkForget).toHaveBeenCalled()
  })

  it('follows the link as it changes, and offers the code again when it was wrong', async () => {
    const { push } = setup(CONNECTED)
    render(<HostLinkCard />)
    await screen.findByText('Connected')
    push({ state: 'offline', address: '192.168.1.20:5051', hostSim: 'disconnected' })
    expect(await screen.findByText('Not reachable, trying again')).toBeInTheDocument()
    push({ state: 'wrong-code', address: '192.168.1.20:5051', hostSim: null })
    expect(await screen.findByText('Wrong code')).toBeInTheDocument()
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument()
  })
})
