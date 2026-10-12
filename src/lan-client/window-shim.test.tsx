import { describe, expect, it } from 'vitest'
import { installWindowShim } from './window-shim'

describe('installWindowShim', () => {
  it('answers the lookups the shared map makes with "nothing here", so it draws without them', async () => {
    installWindowShim()
    const api = window.winglog
    await expect(api.navdataHasTaxiNetwork('WSSS')).resolves.toBe(false)
    await expect(api.navdataRefreshTaxiNetwork('WSSS')).resolves.toBeUndefined()
    await expect(api.navdataGetTaxiNetwork('WSSS')).resolves.toEqual([])
    await expect(api.navdataGetStands('WSSS')).resolves.toEqual([])
    await expect(api.airportListAirfields()).resolves.toEqual([])
    await expect(api.beyondAtcGetTranscript()).resolves.toEqual([])
    expect(api.onBeyondAtcTranscript(() => undefined)()).toBeUndefined()
    await expect(api.appLogRendererError('x', 'y')).resolves.toEqual([])
  })
})
