import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { navdataFetchTimes } from '../db/navdata-repo'
import type { FetchedAirportNavdata, FetchedTaxiNetwork } from './sim-facilities-fetch'
import { SimFacilitiesProvider, type OpenSimConnect } from './sim-facilities-provider'

vi.mock('./sim-facilities-fetch', () => ({
  fetchAirportNavdata: vi.fn(),
  fetchTaxiNetwork: vi.fn(),
  fetchStands: vi.fn()
}))
vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const RUNWAY = {
  latitude: 51.4775,
  longitude: -0.4614,
  headingDeg: 270,
  lengthM: 3902,
  widthM: 50,
  surface: 2,
  primaryIdent: '27R',
  secondaryIdent: '09L'
}
const AIRPORT = (icao: string): FetchedAirportNavdata => ({
  icao,
  runways: [RUNWAY],
  departures: [],
  arrivals: [],
  approaches: []
})
const TAXI = (icao: string): FetchedTaxiNetwork => ({
  icao,
  segments: [
    {
      startLat: 51.3,
      startLon: 0.03,
      endLat: 51.32,
      endLon: 0.02,
      name: 'A',
      startHoldShort: false,
      endHoldShort: false
    }
  ]
})
const STAND = { name: 'N32', nameCode: 25, number: 32, suffix: 0, headingDeg: 161, lat: 22.31, lon: 113.92 }

// AIRAC cycles of 2026: ... 1 Oct, 29 Oct. A cache fetched on 20 Sep belongs to the cycle that began on 3 Sep.
const SEPTEMBER = new Date('2026-09-20T10:00:00Z')
const EARLY_OCTOBER = new Date('2026-10-02T10:00:00Z')
const LATE_OCTOBER = new Date('2026-10-20T10:00:00Z')
const NEXT_CYCLE = new Date('2026-10-30T10:00:00Z')

describe('navdata follows the AIRAC cycle', () => {
  let db: WingLogDb
  let clock: Date
  let close: ReturnType<typeof vi.fn<() => void>>
  let open: ReturnType<typeof vi.fn>
  let provider: SimFacilitiesProvider
  let fetchAirport: ReturnType<typeof vi.fn>
  let fetchTaxi: ReturnType<typeof vi.fn>
  let fetchStands: ReturnType<typeof vi.fn>

  /** Waits for the provider's background refresh, which no caller awaits. */
  const settle = (): Promise<void> => vi.waitFor(() => expect(inFlight()).toBe(0))
  let running = 0
  const inFlight = (): number => running

  beforeEach(async () => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    clock = SEPTEMBER
    close = vi.fn<() => void>()
    running = 0
    open = vi.fn(async () => {
      running++
      return { handle: { close: () => (close(), running--) } }
    })
    const fetches = await import('./sim-facilities-fetch')
    fetchAirport = vi
      .mocked(fetches.fetchAirportNavdata)
      .mockReset()
      .mockImplementation(async (_h, icao) => AIRPORT(icao))
    fetchTaxi = vi
      .mocked(fetches.fetchTaxiNetwork)
      .mockReset()
      .mockImplementation(async (_h, icao) => TAXI(icao))
    fetchStands = vi.mocked(fetches.fetchStands).mockReset().mockResolvedValue([STAND])
    provider = new SimFacilitiesProvider(db, open as unknown as OpenSimConnect, () => clock)
  })

  /** Everything cached for EGLL on 20 September, then the clock moves to `to`. */
  async function cacheEverythingThen(to: Date): Promise<void> {
    await provider.refreshAirport('EGLL')
    await provider.refreshTaxiNetwork('EGLL')
    await provider.getStands('EGLL')
    fetchAirport.mockClear()
    fetchTaxi.mockClear()
    fetchStands.mockClear()
    open.mockClear()
    clock = to
  }

  it('records when each part was fetched', async () => {
    await cacheEverythingThen(SEPTEMBER)
    expect(navdataFetchTimes(db, 'EGLL')).toEqual({
      airport: SEPTEMBER.toISOString(),
      taxi: SEPTEMBER.toISOString(),
      stands: SEPTEMBER.toISOString()
    })
    expect(navdataFetchTimes(db, 'EGKB')).toEqual({ airport: null, taxi: null, stands: null })
  })

  it('serves the cache at once when a new cycle has begun, and refreshes every stale part in the background', async () => {
    await cacheEverythingThen(EARLY_OCTOBER)
    expect(provider.listRunways('EGLL')).toHaveLength(2)
    await vi.waitFor(() => expect(fetchStands).toHaveBeenCalledTimes(1))
    await settle()
    expect(fetchAirport).toHaveBeenCalledTimes(1)
    expect(fetchTaxi).toHaveBeenCalledTimes(1)
    expect(navdataFetchTimes(db, 'EGLL')).toEqual({
      airport: EARLY_OCTOBER.toISOString(),
      taxi: EARLY_OCTOBER.toISOString(),
      stands: EARLY_OCTOBER.toISOString()
    })
  })

  it('refreshes an airport once per cycle, not on every read', async () => {
    await cacheEverythingThen(EARLY_OCTOBER)
    provider.listRunways('EGLL')
    provider.getTaxiNetwork('EGLL')
    provider.listSids('EGLL')
    await vi.waitFor(() => expect(fetchStands).toHaveBeenCalledTimes(1))
    await settle()
    clock = LATE_OCTOBER
    provider.listRunways('EGLL')
    provider.listStars('EGLL')
    provider.listApproaches('EGLL')
    provider.getTaxiNetwork('EGLL')
    await settle()
    expect(fetchAirport).toHaveBeenCalledTimes(1)
    expect(fetchTaxi).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('refreshes again when the next cycle begins', async () => {
    await cacheEverythingThen(EARLY_OCTOBER)
    provider.listRunways('EGLL')
    await vi.waitFor(() => expect(fetchStands).toHaveBeenCalledTimes(1))
    await settle()
    clock = NEXT_CYCLE
    provider.listRunways('EGLL')
    await vi.waitFor(() => expect(fetchAirport).toHaveBeenCalledTimes(2))
  })

  it('leaves a cache from the current cycle alone', async () => {
    await cacheEverythingThen(new Date('2026-09-25T10:00:00Z'))
    provider.listRunways('EGLL')
    provider.getTaxiNetwork('EGLL')
    await provider.getStands('EGLL')
    await settle()
    expect(open).not.toHaveBeenCalled()
  })

  it('refreshes only the parts that are cached, and never fetches an airport it has not cached', async () => {
    await provider.refreshAirport('EGLL')
    fetchAirport.mockClear()
    open.mockClear()
    clock = EARLY_OCTOBER
    provider.listRunways('EGLL')
    provider.listRunways('EGKB')
    provider.getTaxiNetwork('EGLL')
    await vi.waitFor(() => expect(fetchAirport).toHaveBeenCalledTimes(1))
    await settle()
    expect(fetchTaxi).not.toHaveBeenCalled()
    expect(fetchStands).not.toHaveBeenCalled()
    expect(fetchAirport).toHaveBeenCalledWith(expect.anything(), 'EGLL')
    expect(fetchAirport).not.toHaveBeenCalledWith(expect.anything(), 'EGKB')
  })

  it('keeps serving the cache when the sim is not running, and tries again after ten minutes', async () => {
    await cacheEverythingThen(EARLY_OCTOBER)
    open.mockRejectedValue(new Error('Open timeout'))
    expect(provider.listRunways('EGLL')).toHaveLength(2)
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(provider.getTaxiNetwork('EGLL')).toHaveLength(1)
    expect(navdataFetchTimes(db, 'EGLL').airport).toBe(SEPTEMBER.toISOString())
    // Within ten minutes: no second attempt.
    clock = new Date(EARLY_OCTOBER.getTime() + 9 * 60 * 1000)
    provider.listRunways('EGLL')
    expect(open).toHaveBeenCalledTimes(1)
    // After ten minutes, with the sim back: it refreshes.
    open.mockImplementation(async () => ({ handle: { close } }))
    clock = new Date(EARLY_OCTOBER.getTime() + 11 * 60 * 1000)
    provider.listRunways('EGLL')
    await vi.waitFor(() => expect(fetchAirport).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(navdataFetchTimes(db, 'EGLL').stands).not.toBe(SEPTEMBER.toISOString()))
  })

  it('answers stands from the cache and refreshes them when stale, without a second fetch for an empty airport', async () => {
    await provider.getStands('EGLL')
    fetchStands.mockClear()
    clock = EARLY_OCTOBER
    expect(await provider.getStands('EGLL')).toHaveLength(1)
    await vi.waitFor(() => expect(fetchStands).toHaveBeenCalledTimes(1))
  })
})
