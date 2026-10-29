import { describe, expect, it, vi } from 'vitest'
import { installWindowShim } from './window-shim'

describe('installWindowShim', () => {
  it('asks the PC for the lookups the shared map makes', async () => {
    const query = vi.fn((name: string, arg?: unknown) => Promise.resolve({ name, arg }))
    installWindowShim({ latest: () => undefined, query })
    const api = window.winglog
    await expect(api.airportListAirfields()).resolves.toEqual({ name: 'airfields', arg: undefined })
    await expect(api.navdataHasTaxiNetwork('WSSS')).resolves.toEqual({ name: 'taxi.has', arg: 'WSSS' })
    await expect(api.navdataGetTaxiNetwork('WSSS')).resolves.toEqual({ name: 'taxi.get', arg: 'WSSS' })
    await expect(api.navdataGetStands('WSSS')).resolves.toEqual({ name: 'stands', arg: 'WSSS' })
    await expect(api.navdataRefreshTaxiNetwork('WSSS')).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith('taxi.refresh', 'WSSS')
  })

  it('asks the PC for the runways and procedures the Procedures dialog lists', async () => {
    const query = vi.fn((name: string, ...args: unknown[]) => Promise.resolve({ name, args }))
    installWindowShim({ latest: () => undefined, query })
    const api = window.winglog
    await expect(api.navdataListRunways('WSSS')).resolves.toEqual({
      name: 'navdata.listRunways',
      args: ['WSSS']
    })
    await expect(api.navdataListSids('WSSS', '02L')).resolves.toEqual({
      name: 'navdata.listSids',
      args: ['WSSS', '02L']
    })
    await expect(api.navdataListStars('WSSS')).resolves.toEqual({
      name: 'navdata.listStars',
      args: ['WSSS', null]
    })
    await expect(api.navdataListApproaches('WSSS', null)).resolves.toEqual({
      name: 'navdata.listApproaches',
      args: ['WSSS', null]
    })
    await expect(api.navdataGetProcedureWaypoints('WSSS', 'star', 'TEBU1B', '20R')).resolves.toEqual({
      name: 'navdata.procedureWaypoints',
      args: ['WSSS', 'star', 'TEBU1B', '20R', null]
    })
    await expect(api.navdataRefreshAirport('WSSS')).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith('navdata.refreshAirport', 'WSSS')
  })

  it('asks the PC for the live ATIS the weather panel shows, as the same request the PC window makes', async () => {
    const query = vi.fn((name: string, ...args: unknown[]) => Promise.resolve({ name, args }))
    installWindowShim({ latest: () => undefined, query })
    const asked = [{ icao: 'EGLL', slot: 'departure' as const }]
    await expect(window.winglog.onlineAtisGet(asked)).resolves.toEqual({ name: 'online.atis', args: [asked] })
  })

  it('carries on without a chart when the PC cannot refresh one', async () => {
    installWindowShim({ latest: () => undefined, query: () => Promise.reject(new Error('no sim')) })
    await expect(window.winglog.navdataRefreshTaxiNetwork('WSSS')).resolves.toBeUndefined()
  })

  it('answers "nothing here" for anything else the shared code might call', async () => {
    installWindowShim({ latest: () => undefined, query: () => Promise.resolve(null) })
    const api = window.winglog
    await expect(api.beyondAtcGetTranscript()).resolves.toEqual([])
    expect(api.onBeyondAtcTranscript(() => undefined)()).toBeUndefined()
    await expect(api.appLogRendererError('x', 'y')).resolves.toEqual([])
  })
})
