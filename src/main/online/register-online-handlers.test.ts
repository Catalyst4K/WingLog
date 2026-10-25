import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import type { SimTelemetry } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight, getFlight } from '../db/flight-repo'
import { fakeIpc } from '../ipc/fake-ipc'
import { dispatchCommand } from '../live/commands'
import { LiveHub } from '../live/LiveHub'
import { REAL_FEED_URLS } from './feed-urls'
import { getTrafficSwitches, setOnlineNetworkSettings, setPretendCallsign } from './online-settings'
import { registerOnlineHandlers } from './register-online-handlers'
import { openSimTrafficLink } from './sim-traffic-link'

// No test reaches a real sim: opening the traffic connection fails as it does with MSFS closed.
vi.mock('./sim-traffic-link', () => ({
  openSimTrafficLink: vi.fn(() => Promise.reject(new Error('no sim')))
}))

const busy = readFileSync(join(__dirname, '__fixtures__', 'vatsim-busy.json'), 'utf8')

describe('online network handlers', () => {
  let db: WingLogDb
  let liveHub: LiveHub
  let sim: EventEmitter & { getLastTelemetry: () => SimTelemetry | undefined }
  let tracking: EventEmitter & { getActive: () => { flightId: number } | undefined }
  let fetchMock: ReturnType<typeof vi.fn>
  let stop: (() => void) | undefined

  function register(ipc = fakeIpc(), options: { isDevBuild?: boolean } = {}) {
    const registered = registerOnlineHandlers(ipc.ipcMain, {
      db,
      liveHub,
      sim: sim as never,
      trackingController: tracking as never,
      appVersion: '1.6.0',
      isDevBuild: options.isDevBuild ?? false,
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
      ivaoVid: null,
      keepBeyondAtcOnline: false
    })
    invoke(IpcChannels.settingsSetOnlineNetwork, {
      network: 'ivao',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false
    })
    expect(invoke(IpcChannels.settingsGetOnlineNetwork)).toMatchObject({ network: 'ivao' })
    expect(invoke(IpcChannels.networkTrafficGet)).toEqual({
      network: 'ivao',
      state: 'needsVid',
      aircraft: []
    })
  })

  it('refuses settings that are not valid, and keeps the old ones', () => {
    const { invoke } = register()
    invoke(IpcChannels.settingsSetOnlineNetwork, {
      network: 'vatsim',
      vatsimCid: '123',
      ivaoVid: null,
      keepBeyondAtcOnline: false
    })
    expect(() =>
      invoke(IpcChannels.settingsSetOnlineNetwork, {
        network: 'vatsim',
        vatsimCid: '12;DROP',
        ivaoVid: null,
        keepBeyondAtcOnline: false
      })
    ).toThrow('Invalid member number')
    expect(invoke(IpcChannels.settingsGetOnlineNetwork)).toMatchObject({ vatsimCid: '123' })
  })

  it('turns the shared switch on from the window, remembers it, and starts reading the feed', async () => {
    const { invoke } = register()
    setOnlineNetworkSettings(db, {
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false
    })
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
    expect(Object.keys(commands)).toEqual(['traffic.setNetworkOn', 'traffic.setSimOn'])
  })

  it("turns the sim's own layer on from the window, remembers it, and opens the sim connection", async () => {
    const { invoke } = register()
    invoke(IpcChannels.trafficSetSimOn, true)
    expect(getTrafficSwitches(db).simOn).toBe(true)
    expect(invoke(IpcChannels.trafficLayersGet)).toMatchObject({ simOn: true, drawSim: true })
    await vi.waitFor(() => expect(openSimTrafficLink).toHaveBeenCalled())
    // The sim could not be reached (mocked), and the topic says so.
    await vi.waitFor(() =>
      expect(invoke(IpcChannels.simTrafficGet)).toEqual({ state: 'unavailable', aircraft: [] })
    )
    invoke(IpcChannels.trafficSetSimOn, false)
    expect(invoke(IpcChannels.simTrafficGet)).toEqual({ state: 'off', aircraft: [] })
  })

  it('refuses a sim switch that is not a boolean, and a second screen reaches the same switch', () => {
    const { commands, invoke } = register()
    expect(() => invoke(IpcChannels.trafficSetSimOn, 1)).toThrow('Invalid traffic switch')
    dispatchCommand(commands, 'traffic.setSimOn', [true])
    expect(getTrafficSwitches(db).simOn).toBe(true)
  })

  it('does not read the sim while the network layer draws', () => {
    vi.mocked(openSimTrafficLink).mockClear()
    const { invoke } = register()
    setOnlineNetworkSettings(db, {
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false
    })
    invoke(IpcChannels.trafficSetNetworkOn, true)
    invoke(IpcChannels.trafficSetSimOn, true)
    expect(invoke(IpcChannels.trafficLayersGet)).toMatchObject({ drawSim: false, simBlockedByNetwork: true })
    expect(openSimTrafficLink).not.toHaveBeenCalled()
  })

  it('has no centre without a position, and finds one when the sim reports it', async () => {
    sim.getLastTelemetry = () => undefined
    const { invoke } = register()
    setOnlineNetworkSettings(db, {
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false
    })
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

  describe('a flight flown online', () => {
    /** A flight tracked from the busy fixture's first planned pilot's airports, with that pilot's CID. */
    function trackPlannedPilot(): { flightId: number; callsign: string } {
      const raw = JSON.parse(busy) as {
        pilots: {
          cid: number
          callsign: string
          flight_plan: { departure: string; arrival: string } | null
        }[]
      }
      const own = raw.pilots.find((p) => p.flight_plan?.departure && p.flight_plan.arrival)!
      const aircraft = createAircraft(db, { registration: 'G-TEST', icaoType: 'A320' })
      const flight = createFlight(db, {
        aircraftId: aircraft.id,
        depIcao: own.flight_plan!.departure,
        arrIcao: own.flight_plan!.arrival
      })
      setOnlineNetworkSettings(db, {
        network: 'vatsim',
        vatsimCid: String(own.cid),
        ivaoVid: null,
        keepBeyondAtcOnline: false
      })
      tracking.getActive = () => ({ flightId: flight.id })
      return { flightId: flight.id, callsign: own.callsign }
    }

    it('is recorded on the flight when it completes, with the network and callsign seen while airborne', async () => {
      sim.getLastTelemetry = () =>
        ({ latitude: 51.4706, longitude: -0.4619, onGround: false }) as SimTelemetry
      const { flightId, callsign } = trackPlannedPilot()
      const { invoke } = register()
      await vi.waitFor(() =>
        expect((invoke(IpcChannels.onlineStatusGet) as { state: string }).state).toBe('online')
      )
      tracking.emit('completed', flightId)
      expect(getFlight(db, flightId)).toMatchObject({ onlineNetwork: 'vatsim', onlineCallsign: callsign })
    })

    it('is not recorded for a flight flown offline, or seen online only on the ground', async () => {
      sim.getLastTelemetry = () => ({ latitude: 51.4706, longitude: -0.4619, onGround: true }) as SimTelemetry
      const { flightId } = trackPlannedPilot()
      const { invoke } = register()
      await vi.waitFor(() =>
        expect((invoke(IpcChannels.onlineStatusGet) as { state: string }).state).toBe('online')
      )
      tracking.emit('completed', flightId)
      expect(getFlight(db, flightId)).toMatchObject({ onlineNetwork: null, onlineCallsign: null })
    })

    it('forgets what was seen when the flight is dropped or a new one starts', async () => {
      sim.getLastTelemetry = () =>
        ({ latitude: 51.4706, longitude: -0.4619, onGround: false }) as SimTelemetry
      const { flightId } = trackPlannedPilot()
      const { invoke } = register()
      await vi.waitFor(() =>
        expect((invoke(IpcChannels.onlineStatusGet) as { state: string }).state).toBe('online')
      )
      tracking.getActive = () => undefined
      tracking.emit('stopped')
      tracking.emit('completed', flightId)
      expect(getFlight(db, flightId)?.onlineNetwork).toBeNull()
    })
  })

  describe('"Pretend I am this pilot"', () => {
    it('is stored and read back in the dev build, and refused if it is not a callsign', () => {
      const { invoke } = register(fakeIpc(), { isDevBuild: true })
      expect(invoke(IpcChannels.onlineGetPretend)).toBeNull()
      invoke(IpcChannels.onlineSetPretend, 'BAW123')
      expect(invoke(IpcChannels.onlineGetPretend)).toBe('BAW123')
      expect(() => invoke(IpcChannels.onlineSetPretend, 'bad callsign!')).toThrow('Invalid callsign')
      invoke(IpcChannels.onlineSetPretend, null)
      expect(invoke(IpcChannels.onlineGetPretend)).toBeNull()
    })

    it('does nothing in a release build: not stored, and always null', () => {
      const { invoke } = register()
      invoke(IpcChannels.onlineSetPretend, 'BAW123')
      expect(invoke(IpcChannels.onlineGetPretend)).toBeNull()
      setPretendCallsign(db, 'BAW123')
      expect(invoke(IpcChannels.onlineGetPretend)).toBeNull()
    })
  })

  it('looks again when tracking starts or stops, since the flight shown may change', () => {
    sim.getLastTelemetry = () => undefined
    const { invoke } = register()
    setOnlineNetworkSettings(db, {
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false
    })
    invoke(IpcChannels.trafficSetNetworkOn, true)
    for (const event of ['started', 'stopped', 'completed']) tracking.emit(event)
    expect(invoke(IpcChannels.networkTrafficGet)).toMatchObject({ state: 'noCentre' })
  })
})
