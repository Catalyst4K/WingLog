import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import type { NetworkTraffic, SimTelemetry } from '@shared/ipc'
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
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    invoke(IpcChannels.settingsSetOnlineNetwork, {
      network: 'ivao',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
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
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    expect(() =>
      invoke(IpcChannels.settingsSetOnlineNetwork, {
        network: 'vatsim',
        vatsimCid: '12;DROP',
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
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
      keepBeyondAtcOnline: false,
      simTrafficButton: true
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
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    invoke(IpcChannels.trafficSetNetworkOn, true)
    invoke(IpcChannels.trafficSetSimOn, true)
    expect(invoke(IpcChannels.trafficLayersGet)).toMatchObject({ drawSim: false, simBlockedByNetwork: true })
    expect(openSimTrafficLink).not.toHaveBeenCalled()
  })

  it('shows the whole network without a position, and narrows to the aircraft when the sim reports one', async () => {
    sim.getLastTelemetry = () => undefined
    const { invoke } = register()
    setOnlineNetworkSettings(db, {
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    invoke(IpcChannels.trafficSetNetworkOn, true)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect((invoke(IpcChannels.networkTrafficGet) as NetworkTraffic).aircraft.length).toBeGreaterThan(0)
    )
    expect(invoke(IpcChannels.networkTrafficGet)).toMatchObject({ network: 'vatsim', state: 'shown' })
    // The busy capture's pilots are all around London: from Hong Kong, nobody is near, and nothing more is downloaded.
    sim.getLastTelemetry = () => ({ latitude: 22.31, longitude: 113.92 }) as SimTelemetry
    sim.emit('telemetry', {})
    expect(invoke(IpcChannels.networkTrafficGet)).toEqual({ network: 'vatsim', state: 'shown', aircraft: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
        keepBeyondAtcOnline: false,
        simTrafficButton: true
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

  describe('the ATIS lookup', () => {
    const choose = (network: 'vatsim' | 'ivao' | null, ivaoVid: string | null = null): void =>
      setOnlineNetworkSettings(db, {
        network,
        vatsimCid: null,
        ivaoVid,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      })

    it('reads the feed for a request and answers with the ATIS, for the PC window and the second screen alike', async () => {
      const { invoke, atisAt } = register()
      choose('vatsim')
      const asked = [{ icao: 'egll', slot: 'departure' }]
      const answer = (await invoke(IpcChannels.onlineAtisGet, asked)) as {
        airports: { atis: { callsign: string }[] }[]
      }
      expect(answer.airports[0]?.atis.map((a) => a.callsign)).toEqual(['EGLL_D_ATIS'])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // The second screen's lookup is the same function: answered from the feed just read.
      const again = (await atisAt(asked)) as { airports: unknown[] }
      expect(again.airports).toHaveLength(1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['a code that is not four characters', [{ icao: 'EGL', slot: 'departure' }]],
      ['a tab that does not exist', [{ icao: 'EGLL', slot: 'arrival' }]],
      ['something that is not a list', 'EGLL']
    ])('refuses %s, from either screen, without reading anything', async (_name, bad) => {
      const { invoke, atisAt } = register()
      choose('vatsim')
      await expect(Promise.resolve().then(() => invoke(IpcChannels.onlineAtisGet, bad))).rejects.toThrow(
        'Invalid ATIS request'
      )
      await expect(Promise.resolve().then(() => atisAt(bad))).rejects.toThrow('Invalid ATIS request')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('shows nothing, and reads nothing, with no network chosen or IVAO without a VID', async () => {
      const { invoke } = register()
      const asked = [{ icao: 'EGLL', slot: 'departure' }]
      expect(await invoke(IpcChannels.onlineAtisGet, asked)).toEqual({ network: null, airports: [] })
      choose('ivao')
      expect(await invoke(IpcChannels.onlineAtisGet, asked)).toEqual({ network: null, airports: [] })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  it('looks again when tracking starts or stops, since the flight shown may change, and the traffic stays shown', () => {
    sim.getLastTelemetry = () => undefined
    const { invoke } = register()
    setOnlineNetworkSettings(db, {
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    invoke(IpcChannels.trafficSetNetworkOn, true)
    for (const event of ['started', 'stopped', 'completed']) tracking.emit(event)
    expect(invoke(IpcChannels.networkTrafficGet)).toMatchObject({ state: 'shown' })
  })
})
