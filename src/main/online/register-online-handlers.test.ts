import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import type { SimTelemetry } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { fakeIpc } from '../ipc/fake-ipc'
import { dispatchCommand } from '../live/commands'
import { LiveHub } from '../live/LiveHub'
import { REAL_FEED_URLS } from './feed-urls'
import { getTrafficSwitches, setOnlineNetworkSettings } from './online-settings'
import { registerOnlineHandlers } from './register-online-handlers'

const busy = readFileSync(join(__dirname, '__fixtures__', 'vatsim-busy.json'), 'utf8')

describe('online network handlers', () => {
  let db: WingLogDb
  let liveHub: LiveHub
  let sim: EventEmitter & { getLastTelemetry: () => SimTelemetry | undefined }
  let tracking: EventEmitter & { getActive: () => undefined }
  let fetchMock: ReturnType<typeof vi.fn>
  let stop: (() => void) | undefined

  function register(ipc = fakeIpc()) {
    const registered = registerOnlineHandlers(ipc.ipcMain, {
      db,
      liveHub,
      sim: sim as never,
      trackingController: tracking as never,
      appVersion: '1.6.0',
      urls: { ...REAL_FEED_URLS, vatsimStatus: null, vatsimData: 'http://feed.test/vatsim' }
    })
    stop = registered.stop
    return { ...ipc, ...registered }
  }

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    liveHub = new LiveHub()
    sim = Object.assign(new EventEmitter(), {
      getLastTelemetry: () => ({ latitude: 51.4706, longitude: -0.4619 }) as SimTelemetry
    })
    tracking = Object.assign(new EventEmitter(), { getActive: () => undefined })
    fetchMock = vi.fn(() => Promise.resolve(new Response(busy, { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    stop?.()
    stop = undefined
    vi.unstubAllGlobals()
  })

  it('publishes the starting state at once: no network chosen, both layers off', () => {
    const { invoke } = register()
    expect(invoke(IpcChannels.trafficLayersGet)).toMatchObject({ networkOn: false, drawNetwork: false })
    expect(invoke(IpcChannels.networkTrafficGet)).toEqual({ network: null, state: 'noNetwork', aircraft: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stores validated settings and acts on them straight away', () => {
    const { invoke } = register()
    expect(invoke(IpcChannels.settingsGetOnlineNetwork)).toEqual({
      network: null,
      vatsimCid: null,
      ivaoVid: null
    })
    invoke(IpcChannels.settingsSetOnlineNetwork, { network: 'ivao', vatsimCid: null, ivaoVid: null })
    expect(invoke(IpcChannels.settingsGetOnlineNetwork)).toMatchObject({ network: 'ivao' })
    expect(invoke(IpcChannels.networkTrafficGet)).toEqual({
      network: 'ivao',
      state: 'needsVid',
      aircraft: []
    })
  })

  it('refuses settings that are not valid, and keeps the old ones', () => {
    const { invoke } = register()
    invoke(IpcChannels.settingsSetOnlineNetwork, { network: 'vatsim', vatsimCid: '123', ivaoVid: null })
    expect(() =>
      invoke(IpcChannels.settingsSetOnlineNetwork, { network: 'vatsim', vatsimCid: '12;DROP', ivaoVid: null })
    ).toThrow('Invalid member number')
    expect(invoke(IpcChannels.settingsGetOnlineNetwork)).toMatchObject({ vatsimCid: '123' })
  })

  it('turns the shared switch on from the window, remembers it, and starts reading the feed', async () => {
    const { invoke } = register()
    setOnlineNetworkSettings(db, { network: 'vatsim', vatsimCid: null, ivaoVid: null })
    invoke(IpcChannels.trafficSetNetworkOn, true)
    expect(getTrafficSwitches(db).networkOn).toBe(true)
    expect(invoke(IpcChannels.trafficLayersGet)).toMatchObject({ networkOn: true, drawNetwork: true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(
        (invoke(IpcChannels.networkTrafficGet) as { aircraft: unknown[] }).aircraft.length
      ).toBeGreaterThan(0)
    )
  })

  it('refuses a switch that is not a boolean', () => {
    const { invoke } = register()
    expect(() => invoke(IpcChannels.trafficSetNetworkOn, 'yes')).toThrow('Invalid traffic switch')
    expect(getTrafficSwitches(db).networkOn).toBe(false)
  })

  it('hands back a command table a second screen may use, which reaches the same switch', () => {
    const { commands, invoke } = register()
    dispatchCommand(commands, 'traffic.setNetworkOn', [true])
    expect(getTrafficSwitches(db).networkOn).toBe(true)
    expect(invoke(IpcChannels.trafficLayersGet)).toMatchObject({ networkOn: true })
    expect(Object.keys(commands)).toEqual(['traffic.setNetworkOn'])
  })

  it('has no centre without a position, and finds one when the sim reports it', async () => {
    sim.getLastTelemetry = () => undefined
    const { invoke } = register()
    setOnlineNetworkSettings(db, { network: 'vatsim', vatsimCid: null, ivaoVid: null })
    invoke(IpcChannels.trafficSetNetworkOn, true)
    expect(invoke(IpcChannels.networkTrafficGet)).toEqual({
      network: 'vatsim',
      state: 'noCentre',
      aircraft: []
    })
    sim.getLastTelemetry = () => ({ latitude: 51.4706, longitude: -0.4619 }) as SimTelemetry
    sim.emit('telemetry', {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('looks again when tracking starts or stops, since the flight shown may change', () => {
    sim.getLastTelemetry = () => undefined
    const { invoke } = register()
    setOnlineNetworkSettings(db, { network: 'vatsim', vatsimCid: null, ivaoVid: null })
    invoke(IpcChannels.trafficSetNetworkOn, true)
    for (const event of ['started', 'stopped', 'completed']) tracking.emit(event)
    expect(invoke(IpcChannels.networkTrafficGet)).toMatchObject({ state: 'noCentre' })
  })
})
