import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import type { NetworkTraffic, SimTelemetry } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { fakeIpc } from '../ipc/fake-ipc'
import { LiveHub } from '../live/LiveHub'
import { bundledAtcAreas } from './bundled-atc-areas'
import { REAL_FEED_URLS } from './feed-urls'
import { setOnlineNetworkSettings } from './online-settings'
import { registerOnlineHandlers } from './register-online-handlers'

vi.mock('./sim-traffic-link', () => ({
  openSimTrafficLink: vi.fn(() => Promise.reject(new Error('no sim')))
}))

const busy = readFileSync(join(__dirname, '__fixtures__', 'vatsim-busy.json'), 'utf8')

// Sanya (ZJSY): where flight 445 ended. The busy fixture's pilots are all around London, so a map centred here has nobody within 250 nm.
const SANYA_GATE = { latitude: 18.3029, longitude: 109.4122, onGround: true } as SimTelemetry

describe('where the network traffic is centred once the sim has gone', () => {
  let db: WingLogDb
  let liveHub: LiveHub
  let status: { state: string }
  let sim: EventEmitter & {
    getLastTelemetry: () => SimTelemetry | undefined
    getStatus: () => { state: string }
  }
  let stop: (() => void) | undefined

  function showTraffic(): { invoke: ReturnType<typeof fakeIpc>['invoke'] } {
    const ipc = fakeIpc()
    const registered = registerOnlineHandlers(ipc.ipcMain, {
      db,
      liveHub,
      sim: sim as never,
      trackingController: Object.assign(new EventEmitter(), { getActive: () => undefined }) as never,
      appVersion: '2.0.0',
      isDevBuild: false,
      atcAreas: bundledAtcAreas,
      beyondAtcAtis: () => Promise.resolve({ state: 'off', airports: [] }),
      urls: { ...REAL_FEED_URLS, vatsimStatus: null, vatsimData: 'http://feed.test/vatsim' }
    })
    stop = registered.stop
    setOnlineNetworkSettings(db, {
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    ipc.invoke(IpcChannels.trafficSetNetworkOn, true)
    return ipc
  }

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    liveHub = new LiveHub()
    status = { state: 'connected' }
    // As SimConnectService behaves: the last tick is kept after the connection drops (it is never cleared).
    sim = Object.assign(new EventEmitter(), {
      getLastTelemetry: () => SANYA_GATE,
      getStatus: () => status
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(busy, { status: 200 })))
    )
  })

  afterEach(() => {
    stop?.()
    stop = undefined
    vi.unstubAllGlobals()
  })

  it('looks around the aircraft while the sim is connected (the designed 250 nm window)', async () => {
    const { invoke } = showTraffic()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(invoke(IpcChannels.networkTrafficGet)).toMatchObject({ state: 'shown' }))
    expect((invoke(IpcChannels.networkTrafficGet) as NetworkTraffic).aircraft).toEqual([])
  })

  it('shows the whole network while the sim is connected when the whole-network choice is on, and the window again when it is off', async () => {
    const { invoke } = showTraffic()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(invoke(IpcChannels.networkTrafficGet)).toMatchObject({ state: 'shown' }))
    expect((invoke(IpcChannels.networkTrafficGet) as NetworkTraffic).aircraft).toEqual([])
    invoke(IpcChannels.trafficSetNetworkWhole, true)
    expect((invoke(IpcChannels.networkTrafficGet) as NetworkTraffic).aircraft.length).toBeGreaterThan(0)
    invoke(IpcChannels.trafficSetNetworkWhole, false)
    expect((invoke(IpcChannels.networkTrafficGet) as NetworkTraffic).aircraft).toEqual([])
  })

  it('widens to the whole network the moment the sim disconnects, without waiting for the next feed read', async () => {
    const { invoke } = showTraffic()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(invoke(IpcChannels.networkTrafficGet)).toMatchObject({ state: 'shown' }))
    status = { state: 'disconnected' }
    sim.emit('status', status)
    expect((invoke(IpcChannels.networkTrafficGet) as NetworkTraffic).aircraft.length).toBeGreaterThan(0)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("narrows again on the first tick after the sim reconnects, not on the status alone (its last tick is the old flight's)", async () => {
    status = { state: 'disconnected' }
    const { invoke } = showTraffic()
    await vi.waitFor(() =>
      expect((invoke(IpcChannels.networkTrafficGet) as NetworkTraffic).aircraft.length).toBeGreaterThan(0)
    )
    status = { state: 'connected' }
    sim.emit('status', status)
    expect((invoke(IpcChannels.networkTrafficGet) as NetworkTraffic).aircraft.length).toBeGreaterThan(0)
    sim.emit('telemetry', SANYA_GATE)
    expect((invoke(IpcChannels.networkTrafficGet) as NetworkTraffic).aircraft).toEqual([])
  })

  it('shows the whole network, as designed for "no sim position", once the sim has quit, not a window around where the last flight ended', async () => {
    status = { state: 'disconnected' }
    const { invoke } = showTraffic()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect((invoke(IpcChannels.networkTrafficGet) as NetworkTraffic).aircraft.length).toBeGreaterThan(0)
    )
  })
})
