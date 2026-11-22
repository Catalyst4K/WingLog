import { describe, expect, it, vi } from 'vitest'

vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
import { IpcChannels, type ProcedureSelection } from '@shared/ipc'
import { fakeIpc } from '../ipc/fake-ipc'
import { LiveHub } from '../live/LiveHub'
import type { HostLink } from './HostLink'
import { FORWARDED_COMMANDS, NAVDATA_LOOKUPS, registerHostLinkHandlers, TOPIC_GETTERS } from './client-ipc'

function setup(own?: { hostFlying: boolean }) {
  const hub = new LiveHub()
  const link = {
    getStatus: vi.fn(() => ({ state: 'connected', address: '192.168.1.20:5051', hostSim: 'connected' })),
    pair: vi.fn(),
    forget: vi.fn(),
    command: vi.fn(),
    query: vi.fn()
  }
  const ipc = fakeIpc()
  const store = { set: vi.fn(), current: vi.fn((): ProcedureSelection | undefined => undefined) }
  registerHostLinkHandlers(ipc.ipcMain, {
    link: link as unknown as HostLink,
    hub,
    handled: new Set(),
    ...(own && { ownSelection: { store, hostFlying: () => own.hostFlying } })
  })
  return { hub, link, store, ...ipc }
}

describe('a client IPC handlers', () => {
  it('pairs with the typed address and code and returns the status, passing only short text on', () => {
    const { invoke, link } = setup()
    expect(invoke(IpcChannels.hostLinkPair, '192.168.1.20:5051', '123456')).toMatchObject({
      state: 'connected'
    })
    expect(link.pair).toHaveBeenCalledWith('192.168.1.20:5051', '123456', null)
    invoke(IpcChannels.hostLinkPair, { not: 'a string' }, 'x'.repeat(500))
    expect(link.pair).toHaveBeenLastCalledWith('', '', null)
  })

  it('passes a good certificate pin on, and treats a missing one as a typed pairing', () => {
    const { invoke, link } = setup()
    const pin = 'Ab-_09'.repeat(7) + 'A'
    invoke(IpcChannels.hostLinkPair, '192.168.1.20:5051', '123456', pin)
    expect(link.pair).toHaveBeenLastCalledWith('192.168.1.20:5051', '123456', pin)
    invoke(IpcChannels.hostLinkPair, '192.168.1.20:5051', '123456', null)
    expect(link.pair).toHaveBeenLastCalledWith('192.168.1.20:5051', '123456', null)
    invoke(IpcChannels.hostLinkPair, '192.168.1.20:5051', '123456', undefined)
    expect(link.pair).toHaveBeenLastCalledWith('192.168.1.20:5051', '123456', null)
  })

  it('refuses a pin that is not a pin before it pairs, rather than reading it as no pin (which would check nothing)', () => {
    const { invoke, link } = setup()
    const pin = 'Ab-_09'.repeat(7) + 'A'
    for (const bad of [pin.slice(1), `${pin}a`, `${pin.slice(1)}!`, '', 5, {}]) {
      expect(() => invoke(IpcChannels.hostLinkPair, '192.168.1.20:5051', '123456', bad), String(bad)).toThrow(
        'Invalid certificate pin'
      )
    }
    expect(link.pair).not.toHaveBeenCalled()
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

  it('answers a screen asking for the whole network’s traffic from the sim PC, as that PC answered', async () => {
    const { invoke, link } = setup()
    const answer = { network: 'vatsim', state: 'shown', aircraft: [], whole: true }
    link.query.mockResolvedValueOnce(answer)
    await expect(invoke(IpcChannels.networkTrafficWholeGet)).resolves.toBe(answer)
    expect(link.query).toHaveBeenCalledWith('online.trafficWhole')
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

  describe("the window's procedure choice", () => {
    const choice = {
      departureRunway: '07R',
      sidIdent: 'PECA3A',
      sidTransition: null,
      starIdent: 'UPRS3D',
      starTransition: null,
      approachIdent: 'ILS X 08',
      approachTransition: null,
      arrivalIcao: null
    }

    it('goes to the sim PC, as a phone sends it, while the sim PC is flying: this computer holds no copy of that flight to set', () => {
      const { invoke, link, store } = setup({ hostFlying: true })
      invoke(IpcChannels.trackingSetProcedureSelection, choice)
      expect(link.command).toHaveBeenCalledWith('track.setProcedureSelection', [choice])
      expect(store.set).not.toHaveBeenCalled()
    })

    it("stays on this computer's own flight while the sim PC is not flying, and is checked first", () => {
      const { invoke, link, store } = setup({ hostFlying: false })
      invoke(IpcChannels.trackingSetProcedureSelection, choice)
      expect(store.set).toHaveBeenCalledWith(choice, 'window')
      expect(link.command).not.toHaveBeenCalled()
      expect(() => invoke(IpcChannels.trackingSetProcedureSelection, { sidIdent: 7 })).toThrow()
    })

    it("is read from the sim PC's last word when this computer holds none of its own", () => {
      const { invoke, hub, store } = setup({ hostFlying: true })
      expect(invoke(IpcChannels.trackingGetProcedureSelection)).toBeNull()
      hub.publish('procedureSelection', choice)
      expect(invoke(IpcChannels.trackingGetProcedureSelection)).toEqual(choice)
      store.current.mockReturnValue({ ...choice, sidIdent: 'OWN1A' })
      expect(invoke(IpcChannels.trackingGetProcedureSelection)).toMatchObject({ sidIdent: 'OWN1A' })
    })
  })

  it('answers each topic current-value query from what the host last said', () => {
    const { invoke, hub } = setup()
    expect(invoke(IpcChannels.beyondAtcGetState)).toMatchObject({ actions: [] })
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

  it('does not answer the routines list, which is this computer’s own rows now (they sync with the sim PC)', () => {
    const { has } = setup()
    expect(has(IpcChannels.gsxRoutinesList)).toBe(false)
  })

  it('starts a routine only after the two computers are brought level, so one just made here is on the sim PC', async () => {
    const order: string[] = []
    const link = {
      getStatus: vi.fn(),
      commandAfterSync: vi.fn((name: string, args: unknown[]) => {
        order.push(`after-sync ${name} ${JSON.stringify(args)}`)
        return Promise.resolve()
      }),
      command: vi.fn(() => order.push('plain command'))
    }
    const ipc = fakeIpc()
    registerHostLinkHandlers(ipc.ipcMain, {
      link: link as unknown as HostLink,
      hub: new LiveHub(),
      handled: new Set()
    })
    await ipc.invoke(IpcChannels.gsxRoutineStart, 'my-routine-id')
    expect(order).toEqual(['after-sync gsx.startRoutine ["my-routine-id"]'])
    // The other commands are sent at once, as before.
    ipc.invoke(IpcChannels.gsxRoutineCancel)
    expect(order.at(-1)).toBe('plain command')
  })

  it('reads a topic as its empty value before the host has said anything, never as undefined', () => {
    const { invoke, hub } = setup()
    expect(invoke(IpcChannels.gsxRemoteGetStatus)).toEqual({ state: 'disconnected', lastError: null })
    expect(invoke(IpcChannels.beyondAtcGetStatus)).toEqual({ state: 'disconnected', lastError: null })
    expect(invoke(IpcChannels.beyondAtcGetState)).toMatchObject({ actions: [] })
    expect(invoke(IpcChannels.beyondAtcGetTranscript)).toEqual([])
    expect(invoke(IpcChannels.gsxRoutineGet)).toBeNull()
    hub.publish('gsxRemoteStatus', { state: 'connected', lastError: null })
    expect(invoke(IpcChannels.gsxRemoteGetStatus)).toEqual({ state: 'connected', lastError: null })
  })

  it('asks the sim PC whether GSX Remote and BeyondATC are on, and reads them as off while it cannot be asked', async () => {
    const { invoke, link } = setup()
    link.query.mockResolvedValueOnce({ enabled: true, host: '127.0.0.1', port: 8744 })
    expect(await invoke(IpcChannels.settingsGetGsxRemote)).toMatchObject({ enabled: true })
    expect(link.query).toHaveBeenLastCalledWith('settings.gsxRemote')
    link.query.mockResolvedValueOnce({ enabled: true, host: '10.0.0.5' })
    expect(await invoke(IpcChannels.settingsGetBeyondAtc)).toMatchObject({ enabled: true })
    expect(link.query).toHaveBeenLastCalledWith('settings.beyondAtc')
    link.query.mockRejectedValue(new Error('Not connected'))
    expect(await invoke(IpcChannels.settingsGetGsxRemote)).toMatchObject({ enabled: false })
    expect(await invoke(IpcChannels.settingsGetBeyondAtc)).toMatchObject({ enabled: false })
  })

  it('asks the sim PC for runways, procedures, the taxi chart and stands, with the arguments the screen gave', async () => {
    const { invoke, link } = setup()
    link.query.mockResolvedValue([{ ident: '07L' }])
    expect(await invoke(IpcChannels.navdataListRunways, 'VHHH')).toEqual([{ ident: '07L' }])
    expect(link.query).toHaveBeenLastCalledWith('navdata.listRunways', 'VHHH')
    await invoke(IpcChannels.navdataListSids, 'VHHH', '07L')
    expect(link.query).toHaveBeenLastCalledWith('navdata.listSids', 'VHHH', '07L')
    await invoke(IpcChannels.navdataGetProcedureWaypoints, 'VHHH', 'sid', 'BEKOL1A', '07L', null)
    expect(link.query).toHaveBeenLastCalledWith(
      'navdata.procedureWaypoints',
      'VHHH',
      'sid',
      'BEKOL1A',
      '07L',
      null
    )
    await invoke(IpcChannels.navdataGetTaxiNetwork, 'VHHH')
    expect(link.query).toHaveBeenLastCalledWith('taxi.get', 'VHHH')
    await invoke(IpcChannels.navdataHasTaxiNetwork, 'VHHH')
    expect(link.query).toHaveBeenLastCalledWith('taxi.has', 'VHHH')
    await invoke(IpcChannels.navdataGetStands, 'VHHH')
    expect(link.query).toHaveBeenLastCalledWith('stands', 'VHHH')
    expect(NAVDATA_LOOKUPS).toHaveLength(8)
  })

  it('reads the lists as empty while the sim PC cannot be asked, but lets the taxi chart fail so it is not remembered as empty', async () => {
    const { invoke, link } = setup()
    link.query.mockRejectedValue(new Error('Not connected'))
    expect(await invoke(IpcChannels.navdataListRunways, 'VHHH')).toEqual([])
    expect(await invoke(IpcChannels.navdataListApproaches, 'VHHH', null)).toEqual([])
    expect(await invoke(IpcChannels.navdataGetStands, 'VHHH')).toEqual([])
    await expect(invoke(IpcChannels.navdataGetTaxiNetwork, 'VHHH')).rejects.toThrow('Not connected')
    await expect(invoke(IpcChannels.navdataHasTaxiNetwork, 'VHHH')).rejects.toThrow('Not connected')
  })

  it('does nothing for a refresh, which needs a sim, and says an airport is known when the sim PC has runways for it', async () => {
    const { invoke, link } = setup()
    expect(await invoke(IpcChannels.navdataRefreshAirport, 'VHHH')).toBeUndefined()
    expect(await invoke(IpcChannels.navdataRefreshTaxiNetwork, 'VHHH')).toBeUndefined()
    expect(link.query).not.toHaveBeenCalled()
    link.query.mockResolvedValueOnce([{ ident: '07L' }])
    expect(await invoke(IpcChannels.navdataHasAirport, 'VHHH')).toBe(true)
    link.query.mockResolvedValueOnce([])
    expect(await invoke(IpcChannels.navdataHasAirport, 'VHHH')).toBe(false)
    link.query.mockRejectedValueOnce(new Error('Not connected'))
    expect(await invoke(IpcChannels.navdataHasAirport, 'VHHH')).toBe(false)
  })

  it('takes over the airport-data channels the local navdata handlers already answer', () => {
    const ipc = fakeIpc()
    const remove = vi.spyOn(ipc.ipcMain, 'removeHandler')
    const channels = NAVDATA_LOOKUPS.map(([channel]) => channel)
    registerHostLinkHandlers(ipc.ipcMain, {
      link: { query: vi.fn() } as unknown as HostLink,
      hub: new LiveHub(),
      handled: new Set(channels)
    })
    expect(remove.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(channels))
  })

  it('does not take the sim connection status, which the sim handler answers (from the host on a client)', () => {
    expect(Object.values(TOPIC_GETTERS)).not.toContain(IpcChannels.simConnectionStatusGet)
  })
})
