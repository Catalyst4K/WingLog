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

const UNPAIRED: HostLinkStatus = {
  state: 'unpaired',
  address: null,
  hostSim: null,
  sync: { state: 'idle', lastSyncedAt: null, problem: null }
}
const CONNECTED: HostLinkStatus = {
  state: 'connected',
  address: '192.168.1.20:5051',
  hostSim: 'connected',
  sync: { state: 'idle', lastSyncedAt: null, problem: null }
}

/** A certificate pin, as a pasted pairing text carries it. */
const PIN = 'Ab-_09'.repeat(7) + 'A'

/** The link's status in a state, for an address already paired. */
function inState(state: HostLinkStatus['state']): HostLinkStatus {
  return { ...CONNECTED, state, hostSim: null }
}

describe('HostLinkCard', () => {
  it.each([
    ['pair-again', 'Pair again', /link to the sim PC is now encrypted\. Pair this computer again/],
    [
      'certificate-changed',
      'Certificate changed',
      /security certificate has changed since this computer paired.*pretending to be the sim PC/
    ],
    [
      'not-secure',
      'Not encrypted',
      /did not answer with an encrypted connection\. Update WingLog on the sim PC/
    ]
  ] as const)(
    'says what happened and what to do when the link is %s, and offers the address and code again',
    async (state, badge, line) => {
      setup(inState(state))
      render(<HostLinkCard />)
      expect(await screen.findByText(badge)).toBeInTheDocument()
      expect(await screen.findByRole('alert')).toHaveTextContent(line)
      expect(screen.getByLabelText('Address')).toBeInTheDocument()
      expect(screen.getByLabelText('Pairing code')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Forget this sim PC' })).toBeInTheDocument()
    }
  )

  it('pairs again from a changed certificate with what was typed', async () => {
    const { api } = setup(inState('certificate-changed'))
    render(<HostLinkCard />)
    await userEvent.type(await screen.findByLabelText('Address'), '192.168.1.20:5051')
    await userEvent.type(screen.getByLabelText('Pairing code'), '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(api.hostLinkPair).toHaveBeenCalledWith('192.168.1.20:5051', '123456', null)
  })

  it('has no such line, and no pairing fields, while the link is connected or offline', async () => {
    const { push } = setup(CONNECTED)
    render(<HostLinkCard />)
    await screen.findByText('Connected')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    push(inState('offline'))
    await screen.findByText('Not reachable, trying again')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Address')).not.toBeInTheDocument()
  })

  it('asks for the address and the code, and pairs with what was typed', async () => {
    const { api } = setup(UNPAIRED)
    render(<HostLinkCard />)
    const connect = await screen.findByRole('button', { name: 'Connect' })
    expect(connect).toBeDisabled()
    expect(screen.getByText('Not paired')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Address'), '192.168.1.20:5051')
    await userEvent.type(screen.getByLabelText('Pairing code'), '123456')
    await userEvent.click(connect)
    // Typed: no pin, so the connection takes the certificate the sim PC shows and pins it.
    expect(api.hostLinkPair).toHaveBeenCalledWith('192.168.1.20:5051', '123456', null)
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
    expect(api.hostLinkPair).toHaveBeenCalledWith('192.168.1.20:5051', '123456', null)
  })

  it('keeps the pin in pasted pairing text, without showing it, and pairs with it', async () => {
    const { api } = setup(UNPAIRED)
    render(<HostLinkCard />)
    const address = await screen.findByLabelText('Address')
    await userEvent.click(address)
    await userEvent.paste(`winglog-pair://192.168.1.20:5051/123456/${PIN}`)
    expect(address).toHaveValue('192.168.1.20:5051')
    expect(screen.getByLabelText('Pairing code')).toHaveValue('123456')
    expect(screen.queryByDisplayValue(PIN)).not.toBeInTheDocument()
    expect(screen.queryByText(PIN)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(api.hostLinkPair).toHaveBeenCalledWith('192.168.1.20:5051', '123456', PIN)
  })

  it('drops the pin when the address is then edited by hand: it belonged to the address that was pasted', async () => {
    const { api } = setup(UNPAIRED)
    render(<HostLinkCard />)
    const address = await screen.findByLabelText('Address')
    await userEvent.click(address)
    await userEvent.paste(`winglog-pair://192.168.1.20:5051/123456/${PIN}`)
    await userEvent.type(address, '9')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(api.hostLinkPair).toHaveBeenCalledWith('192.168.1.20:50519', '123456', null)
  })

  it('does not carry a pin over to the next pairing after one that worked', async () => {
    const { api } = setup(UNPAIRED)
    render(<HostLinkCard />)
    const address = await screen.findByLabelText('Address')
    await userEvent.click(address)
    await userEvent.paste(`winglog-pair://192.168.1.20:5051/123456/${PIN}`)
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await userEvent.type(screen.getByLabelText('Pairing code'), '654321')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(api.hostLinkPair).toHaveBeenLastCalledWith('192.168.1.20:5051', '654321', null)
  })

  it('says what is wrong with an address the app refuses', async () => {
    setup(UNPAIRED, () => Promise.reject(new Error('Enter the sim PC’s address with its port')))
    render(<HostLinkCard />)
    await userEvent.type(await screen.findByLabelText('Address'), 'example.com:5051')
    await userEvent.type(screen.getByLabelText('Pairing code'), '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText(/address on your home network/)).toBeInTheDocument()
  })

  it('says nothing about versions while the two computers can sync', async () => {
    setup(CONNECTED)
    render(<HostLinkCard />)
    await screen.findByText('Paired with 192.168.1.20:5051')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['update-this-computer', /WingLog is older than the sim PC.s.*Update WingLog on this computer/],
    ['update-sim-pc', /sim PC.s WingLog is older than this computer.s.*Update WingLog on the sim PC/]
  ] as const)('says which computer to update when the versions differ (%s)', async (problem, message) => {
    setup({ ...CONNECTED, sync: { state: 'error', lastSyncedAt: null, problem } })
    render(<HostLinkCard />)
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('shows the message as soon as the link reports it', async () => {
    const { push } = setup(CONNECTED)
    render(<HostLinkCard />)
    await screen.findByText('Paired with 192.168.1.20:5051')
    push({ ...CONNECTED, sync: { state: 'error', lastSyncedAt: null, problem: 'update-sim-pc' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Update WingLog on the sim PC')
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
    push({
      state: 'offline',
      address: '192.168.1.20:5051',
      hostSim: 'disconnected',
      sync: { state: 'idle', lastSyncedAt: null, problem: null }
    })
    expect(await screen.findByText('Not reachable, trying again')).toBeInTheDocument()
    push({
      state: 'wrong-code',
      address: '192.168.1.20:5051',
      hostSim: null,
      sync: { state: 'idle', lastSyncedAt: null, problem: null }
    })
    expect(await screen.findByText('Wrong code')).toBeInTheDocument()
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument()
  })
})
