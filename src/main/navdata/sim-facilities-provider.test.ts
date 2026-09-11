import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { hasCachedAirport, listCachedRunways } from '../db/navdata-repo'
import type { FetchedAirportNavdata } from './sim-facilities-fetch'
import { SimFacilitiesProvider, type OpenSimConnect } from './sim-facilities-provider'

vi.mock('./sim-facilities-fetch', () => ({
  fetchAirportNavdata: vi.fn()
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

    const { fetchAirportNavdata } = await import('./sim-facilities-fetch')
    vi.mocked(fetchAirportNavdata).mockReset()
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
})
