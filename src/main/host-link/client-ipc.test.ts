import { describe, expect, it, vi } from 'vitest'

vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
import { IpcChannels } from '@shared/ipc'
import { fakeIpc } from '../ipc/fake-ipc'
import { LiveHub } from '../live/LiveHub'
import type { HostLink } from './HostLink'
import { FORWARDED_COMMANDS, registerHostLinkHandlers, TOPIC_GETTERS } from './client-ipc'

function setup() {
  const hub = new LiveHub()
  const link = {
    getStatus: vi.fn(() => ({ state: 'connected', address: '192.168.1.20:5051', hostSim: 'connected' })),
    pair: vi.fn(),
    forget: vi.fn(),
    command: vi.fn()
  }
  const ipc = fakeIpc()
  registerHostLinkHandlers(ipc.ipcMain, { link: link as unknown as HostLink, hub, handled: new Set() })
  return { hub, link, ...ipc }
}

describe('a client IPC handlers', () => {
  it('pairs with the typed address and code and returns the status, passing only short text on', () => {
    const { invoke, link } = setup()
    expect(invoke(IpcChannels.hostLinkPair, '192.168.1.20:5051', '123456')).toMatchObject({
      state: 'connected'
    })
    expect(link.pair).toHaveBeenCalledWith('192.168.1.20:5051', '123456')
    invoke(IpcChannels.hostLinkPair, { not: 'a string' }, 'x'.repeat(500))
    expect(link.pair).toHaveBeenLastCalledWith('', '')
  })

  it('reports the status and forgets the sim PC', () => {
    const { invoke, link } = setup()
    expect(invoke(IpcChannels.hostLinkGetStatus)).toEqual({
      state: 'connected',
      address: '192.168.1.20:5051',
      hostSim: 'connected'
    })
    invoke(IpcChannels.hostLinkForget)
    expect(link.forget).toHaveBeenCalled()
  })

  it('forwards each command a phone may send to the host, by its name', () => {
    const { invoke, link } = setup()
    invoke(IpcChannels.beyondAtcSetAction, 'Request Taxi')
    expect(link.command).toHaveBeenLastCalledWith('atc.setAction', ['Request Taxi'])
    invoke(IpcChannels.gsxRemoteSubmitPrompt, 3, '12000')
    expect(link.command).toHaveBeenLastCalledWith('gsx.submitPrompt', [3, '12000'])
    invoke(IpcChannels.gsxRoutineCancel)
    expect(link.command).toHaveBeenLastCalledWith('gsx.cancelRoutine', [])
    invoke(IpcChannels.trafficSetNetworkOn, true)
    expect(link.command).toHaveBeenLastCalledWith('traffic.setNetworkOn', [true])
    expect(Object.keys(FORWARDED_COMMANDS)).toHaveLength(17)
  })

  it('never forwards the command that acts on this computer own flight', () => {
    expect(FORWARDED_COMMANDS['track.setProcedureSelection']).toBeUndefined()
  })

  it('answers each topic current-value query from what the host last said', () => {
    const { invoke, hub } = setup()
    expect(invoke(IpcChannels.beyondAtcGetState)).toBeUndefined()
    hub.publish('beyondAtcStatus', { state: 'connected', lastError: null })
    expect(invoke(IpcChannels.beyondAtcGetStatus)).toEqual({ state: 'connected', lastError: null })
    expect(Object.keys(TOPIC_GETTERS)).toContain('gsxRoutine')
  })

  it('takes over a channel a local service already answers, since a second handler throws at startup', () => {
    const hub = new LiveHub()
    const ipc = fakeIpc()
    // Local services answered the taxi route's first render and the GSX menu command before the link started.
    ipc.ipcMain.handle(IpcChannels.taxiRouteGet, () => 'local')
    ipc.ipcMain.handle(IpcChannels.gsxRemotePickMenu, () => 'local')
    const remove = vi.spyOn(ipc.ipcMain, 'removeHandler')
    const link = { command: vi.fn() }
    hub.publish('taxiRoute', null)
    registerHostLinkHandlers(ipc.ipcMain, {
      link: link as unknown as HostLink,
      hub,
      handled: new Set([IpcChannels.taxiRouteGet, IpcChannels.gsxRemotePickMenu])
    })
    expect(remove.mock.calls.map((call) => call[0]).sort()).toEqual(
      [IpcChannels.taxiRouteGet, IpcChannels.gsxRemotePickMenu].sort()
    )
    expect(ipc.invoke(IpcChannels.taxiRouteGet)).toBeNull()
    ipc.invoke(IpcChannels.gsxRemotePickMenu, 2)
    expect(link.command).toHaveBeenCalledWith('gsx.pickMenu', [2])
  })

  it('does not take the sim connection status, which the sim handler answers (from the host on a client)', () => {
    expect(Object.values(TOPIC_GETTERS)).not.toContain(IpcChannels.simConnectionStatusGet)
  })
})
