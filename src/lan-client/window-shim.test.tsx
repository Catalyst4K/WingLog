import { describe, expect, it, vi } from 'vitest'
import { installWindowShim } from './window-shim'

describe('installWindowShim', () => {
  it('asks the PC for the lookups the shared map makes', async () => {
    const query = vi.fn((name: string, arg?: unknown) => Promise.resolve({ name, arg }))
    installWindowShim({ query })
    const api = window.winglog
    await expect(api.airportListAirfields()).resolves.toEqual({ name: 'airfields', arg: undefined })
    await expect(api.navdataHasTaxiNetwork('WSSS')).resolves.toEqual({ name: 'taxi.has', arg: 'WSSS' })
    await expect(api.navdataGetTaxiNetwork('WSSS')).resolves.toEqual({ name: 'taxi.get', arg: 'WSSS' })
    await expect(api.navdataGetStands('WSSS')).resolves.toEqual({ name: 'stands', arg: 'WSSS' })
    await expect(api.navdataRefreshTaxiNetwork('WSSS')).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith('taxi.refresh', 'WSSS')
  })

  it('carries on without a chart when the PC cannot refresh one', async () => {
    installWindowShim({ query: () => Promise.reject(new Error('no sim')) })
    await expect(window.winglog.navdataRefreshTaxiNetwork('WSSS')).resolves.toBeUndefined()
  })

  it('answers "nothing here" for anything else the shared code might call', async () => {
    installWindowShim({ query: () => Promise.resolve(null) })
    const api = window.winglog
    await expect(api.beyondAtcGetTranscript()).resolves.toEqual([])
    expect(api.onBeyondAtcTranscript(() => undefined)()).toBeUndefined()
    await expect(api.appLogRendererError('x', 'y')).resolves.toEqual([])
  })
})
