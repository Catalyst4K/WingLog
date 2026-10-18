import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import {
  hasCachedAirport,
  hasCachedTaxiNetwork,
  listCachedRunways,
  listCachedTaxiSegments
} from '../db/navdata-repo'
import type { FetchedAirportNavdata, FetchedTaxiNetwork } from './sim-facilities-fetch'
import { SimFacilitiesProvider, type OpenSimConnect } from './sim-facilities-provider'

vi.mock('./sim-facilities-fetch', () => ({
  fetchAirportNavdata: vi.fn(),
  fetchTaxiNetwork: vi.fn(),
  fetchStands: vi.fn()
}))

const FETCHED: FetchedAirportNavdata = {
  icao: 'EGLL',
  runways: [
    {
      latitude: 51.4775,
      longitude: -0.4614,
      headingDeg: 270,
      lengthM: 3902,
      widthM: 50,
      surface: 2,
      primaryIdent: '27R',
      secondaryIdent: '09L'
    }
  ],
  departures: [],
  arrivals: [],
  approaches: []
}

describe('SimFacilitiesProvider', () => {
  let db: WingLogDb
  let close: ReturnType<typeof vi.fn>
  let openSimConnect: OpenSimConnect

  beforeEach(async () => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db

    close = vi.fn()
    openSimConnect = vi.fn(async () => ({ handle: { close } })) as unknown as OpenSimConnect

    const { fetchAirportNavdata, fetchTaxiNetwork } = await import('./sim-facilities-fetch')
    vi.mocked(fetchAirportNavdata).mockReset()
    vi.mocked(fetchTaxiNetwork).mockReset()
  })

  it('opens a connection, fetches, caches the result, and closes the connection', async () => {
    const { fetchAirportNavdata } = await import('./sim-facilities-fetch')
    vi.mocked(fetchAirportNavdata).mockResolvedValue(FETCHED)

    const provider = new SimFacilitiesProvider(db, openSimConnect)
    await provider.refreshAirport('EGLL')

    expect(openSimConnect).toHaveBeenCalledTimes(1)
    expect(fetchAirportNavdata).toHaveBeenCalledWith({ close }, 'EGLL')
    expect(close).toHaveBeenCalledTimes(1)
    expect(hasCachedAirport(db, 'EGLL')).toBe(true)
    expect(listCachedRunways(db, 'EGLL')).toHaveLength(2)
  })

  it('still closes the connection when the fetch throws', async () => {
    const { fetchAirportNavdata } = await import('./sim-facilities-fetch')
    vi.mocked(fetchAirportNavdata).mockRejectedValue(new Error('sim not running'))

    const provider = new SimFacilitiesProvider(db, openSimConnect)
    await expect(provider.refreshAirport('EGLL')).rejects.toThrow('sim not running')
    expect(close).toHaveBeenCalledTimes(1)
    expect(hasCachedAirport(db, 'EGLL')).toBe(false)
  })

  it('reports no cached airport before any refresh', () => {
    const provider = new SimFacilitiesProvider(db, openSimConnect)
    expect(provider.hasAirport('EGLL')).toBe(false)
    expect(provider.listRunways('EGLL')).toEqual([])
    expect(provider.listSids('EGLL')).toEqual([])
    expect(provider.listStars('EGLL')).toEqual([])
    expect(provider.listApproaches('EGLL')).toEqual([])
    expect(provider.getProcedureWaypoints('EGLL', 'sid', 'TEST1A')).toEqual([])
  })

  it('reads back cached data through the provider interface after a refresh', async () => {
    const { fetchAirportNavdata } = await import('./sim-facilities-fetch')
    vi.mocked(fetchAirportNavdata).mockResolvedValue(FETCHED)

    const provider = new SimFacilitiesProvider(db, openSimConnect)
    await provider.refreshAirport('EGLL')

    expect(provider.hasAirport('EGLL')).toBe(true)
    expect(provider.listRunways('EGLL')).toHaveLength(2)
  })

  describe('stands (stand-positions.md)', () => {
    const N32 = {
      name: 'N32',
      nameCode: 25,
      number: 32,
      suffix: 0,
      headingDeg: 161,
      lat: 22.3141453,
      lon: 113.9286249
    }

    it('fetches on first ask, caches, closes the connection, and serves the cache after', async () => {
      const { fetchStands } = await import('./sim-facilities-fetch')
      vi.mocked(fetchStands).mockResolvedValue([N32])
      const provider = new SimFacilitiesProvider(db, openSimConnect)

      expect(await provider.getStands('VHHH')).toEqual([
        { name: 'N32', number: 32, suffix: 0, headingDeg: 161, lat: 22.3141453, lon: 113.9286249 }
      ])
      expect(close).toHaveBeenCalledTimes(1)
      await provider.getStands('VHHH')
      expect(openSimConnect).toHaveBeenCalledTimes(1)
    })

    it('gives an empty list, never a rejection, when the sim is not running', async () => {
      const failingOpen = vi.fn(async () => {
        throw new Error('Open timeout')
      }) as unknown as OpenSimConnect
      expect(await new SimFacilitiesProvider(db, failingOpen).getStands('VHHH')).toEqual([])
    })

    it('does not ask again this session for an airport with no stands', async () => {
      const { fetchStands } = await import('./sim-facilities-fetch')
      vi.mocked(fetchStands).mockResolvedValue([])
      const provider = new SimFacilitiesProvider(db, openSimConnect)
      await provider.getStands('EGKB')
      await provider.getStands('EGKB')
      expect(openSimConnect).toHaveBeenCalledTimes(1)
    })
  })

  describe('taxi network', () => {
    const FETCHED_TAXI: FetchedTaxiNetwork = {
      icao: 'EGKB',
      segments: [
        {
          startLat: 51.338,
          startLon: 0.038,
          endLat: 51.324,
          endLon: 0.027,
          name: null,
          startHoldShort: false,
          endHoldShort: false
        }
      ]
    }

    it('opens a connection, fetches, caches the result, and closes the connection', async () => {
      const { fetchTaxiNetwork } = await import('./sim-facilities-fetch')
      vi.mocked(fetchTaxiNetwork).mockResolvedValue(FETCHED_TAXI)

      const provider = new SimFacilitiesProvider(db, openSimConnect)
      await provider.refreshTaxiNetwork('EGKB')

      expect(openSimConnect).toHaveBeenCalledTimes(1)
      expect(fetchTaxiNetwork).toHaveBeenCalledWith({ close }, 'EGKB')
      expect(close).toHaveBeenCalledTimes(1)
      expect(hasCachedTaxiNetwork(db, 'EGKB')).toBe(true)
      expect(listCachedTaxiSegments(db, 'EGKB')).toHaveLength(1)
    })

    it('still closes the connection when the fetch throws', async () => {
      const { fetchTaxiNetwork } = await import('./sim-facilities-fetch')
      vi.mocked(fetchTaxiNetwork).mockRejectedValue(new Error('sim not running'))

      const provider = new SimFacilitiesProvider(db, openSimConnect)
      await expect(provider.refreshTaxiNetwork('EGKB')).rejects.toThrow('sim not running')
      expect(close).toHaveBeenCalledTimes(1)
      expect(hasCachedTaxiNetwork(db, 'EGKB')).toBe(false)
    })

    it('reports no cached taxi network before any refresh', () => {
      const provider = new SimFacilitiesProvider(db, openSimConnect)
      expect(provider.hasTaxiNetwork('EGKB')).toBe(false)
      expect(provider.getTaxiNetwork('EGKB')).toEqual([])
    })

    it('reads back cached data through the provider interface after a refresh', async () => {
      const { fetchTaxiNetwork } = await import('./sim-facilities-fetch')
      vi.mocked(fetchTaxiNetwork).mockResolvedValue(FETCHED_TAXI)

      const provider = new SimFacilitiesProvider(db, openSimConnect)
      await provider.refreshTaxiNetwork('EGKB')

      expect(provider.hasTaxiNetwork('EGKB')).toBe(true)
      expect(provider.getTaxiNetwork('EGKB')).toEqual(FETCHED_TAXI.segments)
    })
  })
})
