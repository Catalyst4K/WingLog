import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDbHandle } from '../db/client'
import { NetworkFeedService } from './NetworkFeedService'
import {
  getOnlineNetworkSettings,
  getTrafficSwitches,
  setOnlineNetworkSettings,
  setTrafficSwitches
} from './online-settings'

// A quit can land inside a database statement (an outside close is a V8 interrupt), and a read made there throws; a custom SQL function
// runs JS inside a statement the same way, deterministically.
describe('NetworkFeedService when the app quits during a statement', () => {
  let handle: WingLogDbHandle
  let service: NetworkFeedService

  beforeEach(() => {
    handle = createDb(':memory:')
    migrate(handle.db, { migrationsFolder: 'drizzle' })
    const db = handle.db
    service = new NetworkFeedService({
      hub: { publish: () => {} },
      // A read that never ends: the ATIS request below stays waiting for it.
      fetch: () => new Promise<Response>(() => {}),
      now: () => Date.now(),
      timers: { set: () => 0, clear: () => {} },
      urls: { vatsimStatus: null, vatsimData: 'http://feed.test/vatsim', ivao: 'http://feed.test/ivao' },
      appVersion: '2.0.0',
      // Wired as register-online-handlers.ts wires them: every read goes to the database.
      settings: () => getOnlineNetworkSettings(db),
      switches: () => getTrafficSwitches(db),
      saveSwitches: (switches) => setTrafficSwitches(db, switches),
      atcAreas: () => null,
      airportAt: () => null,
      centre: () => null,
      trackedFlight: () => null,
      isAirborne: () => false,
      pretendCallsign: () => null,
      log: { warn: () => {} }
    })
  })

  /**
   * Runs `action` as JS inside a running statement, as the interrupt does.
   *
   * @param action What runs.
   * @returns What it threw, or undefined.
   */
  function runInsideStatement(action: () => void): unknown {
    let thrown: unknown
    handle.sqlite.function('run_inside_statement', () => {
      try {
        action()
      } catch (error) {
        thrown = error
      }
      return 1
    })
    handle.sqlite.prepare('select run_inside_statement()').get()
    return thrown
  }

  it('is as it was: the database really is busy to a read made inside a statement', () => {
    const thrown = runInsideStatement(() => getOnlineNetworkSettings(handle.db))
    expect(thrown).toBeInstanceOf(TypeError)
    expect((thrown as Error).message).toBe('This database connection is busy executing a query')
  })

  it('stops without reading the database when nothing is waiting', () => {
    service.start()
    expect(runInsideStatement(() => service.stop())).toBeUndefined()
  })

  it('stops, and answers an ATIS request that is waiting for the feed as unavailable, without reading the database', async () => {
    setOnlineNetworkSettings(handle.db, {
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    const waiting = service.atisAt([{ icao: 'EGLL', slot: 'departure' }])
    expect(runInsideStatement(() => service.stop())).toBeUndefined()
    const answer = await waiting
    expect(answer.network).toBe('vatsim')
    expect(answer.airports[0]).toMatchObject({ icao: 'EGLL', state: 'unavailable', atis: [] })
  })
})
