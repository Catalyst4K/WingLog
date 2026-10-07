import { describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/ipc'
import { registerLookupHandlers } from './lookup-handlers'
import { fakeIpc } from './fake-ipc'

vi.mock('electron', () => ({ app: { getVersion: () => '1.4.1' } }))
const fetchAircraftByRegistration = vi.fn()
vi.mock('../aircraft-lookup/adsbdb-client', () => ({
  fetchAircraftByRegistration: (r: string) => fetchAircraftByRegistration(r)
}))
const fetchAirframesForType = vi.fn()
vi.mock('../simbrief/simbrief-airframes', () => ({
  fetchAirframesForType: (t: string) => fetchAirframesForType(t)
}))
const createCustomAirframeFromShare = vi.fn()
vi.mock('../simbrief/simbrief-generate', () => ({
  createCustomAirframeFromShare: (u: string) => createCustomAirframeFromShare(u)
}))
const fetchMetars = vi.fn()
vi.mock('../weather/metar-client', () => ({
  fetchMetars: (codes: unknown, agent: string) => fetchMetars(codes, agent)
}))
const fetchExchangeRate = vi.fn()
vi.mock('../fx/fx-client', () => ({ fetchExchangeRate: (c: string, d?: string) => fetchExchangeRate(c, d) }))

describe('lookup IPC handlers', () => {
  const { ipcMain, invoke } = fakeIpc()
  registerLookupHandlers(ipcMain)

  it('searches the vendored lists', () => {
    expect(invoke(IpcChannels.airportSearch, 'heathrow')).toEqual(
      expect.arrayContaining([expect.objectContaining({ icao: 'EGLL' })])
    )
    expect((invoke(IpcChannels.airportListAirfields) as unknown[]).length).toBeGreaterThan(1000)
    expect(invoke(IpcChannels.airlineSearch, 'cathay')).toEqual(
      expect.arrayContaining([expect.objectContaining({ icao: 'CPA' })])
    )
    expect(invoke(IpcChannels.airlineFindByIcao, 'BAW')).toMatchObject({ icao: 'BAW' })
    expect(invoke(IpcChannels.aircraftTypeSearch, 'A320')).toEqual(
      expect.arrayContaining([expect.objectContaining({ icaoType: 'A320' })])
    )
  })

  it('passes the online lookups through, METARs with WingLog as the user agent', () => {
    invoke(IpcChannels.aircraftLookupByRegistration, 'G-EUPT')
    invoke(IpcChannels.simbriefAirframesForType, 'A20N')
    invoke(IpcChannels.simbriefCreateCustomAirframe, 'https://dispatch.simbrief.com/airframes/share/1')
    invoke(IpcChannels.weatherGetMetars, ['EGLL'])
    invoke(IpcChannels.fxGetRate, 'GBP', '2026-10-05')
    expect(fetchAircraftByRegistration).toHaveBeenCalledWith('G-EUPT')
    expect(fetchAirframesForType).toHaveBeenCalledWith('A20N')
    expect(createCustomAirframeFromShare).toHaveBeenCalledWith(
      'https://dispatch.simbrief.com/airframes/share/1'
    )
    expect(fetchMetars).toHaveBeenCalledWith(['EGLL'], 'WingLog/1.4.1')
    expect(fetchExchangeRate).toHaveBeenCalledWith('GBP', '2026-10-05')
  })
})
