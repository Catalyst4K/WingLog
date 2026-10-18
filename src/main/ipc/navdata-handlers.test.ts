import { describe, expect, it, vi } from 'vitest'
import { logger } from '../logging/logger'
import { IpcChannels } from '@shared/ipc'
import type { NavdataProvider } from '../navdata/navdata-provider'
import { registerNavdataHandlers } from './navdata-handlers'
import { fakeIpc } from './fake-ipc'

describe('navdata IPC handlers', () => {
  const provider = {
    refreshAirport: vi.fn(),
    hasAirport: vi.fn(),
    listRunways: vi.fn(),
    listSids: vi.fn(),
    listStars: vi.fn(),
    listApproaches: vi.fn(),
    getProcedureWaypoints: vi.fn(),
    refreshTaxiNetwork: vi.fn(),
    hasTaxiNetwork: vi.fn(),
    getTaxiNetwork: vi.fn(),
    getStands: vi.fn(() => [{ name: '12' }])
  }
  const { ipcMain, invoke } = fakeIpc()
  registerNavdataHandlers(ipcMain, { navdataProvider: provider as unknown as NavdataProvider })

  it('passes each lookup to the provider with its arguments', () => {
    invoke(IpcChannels.navdataRefreshAirport, 'ZJSY')
    invoke(IpcChannels.navdataHasAirport, 'ZJSY')
    invoke(IpcChannels.navdataListRunways, 'ZJSY')
    invoke(IpcChannels.navdataListSids, 'VHHH', '07R')
    invoke(IpcChannels.navdataListStars, 'ZJSY', null)
    invoke(IpcChannels.navdataListApproaches, 'ZJSY', '08')
    invoke(IpcChannels.navdataGetProcedureWaypoints, 'VHHH', 'sid', 'OCEAN2A', '07R', null)
    invoke(IpcChannels.navdataRefreshTaxiNetwork, 'ZJSY')
    invoke(IpcChannels.navdataHasTaxiNetwork, 'ZJSY')
    invoke(IpcChannels.navdataGetTaxiNetwork, 'ZJSY')
    expect(provider.refreshAirport).toHaveBeenCalledWith('ZJSY')
    expect(provider.hasAirport).toHaveBeenCalledWith('ZJSY')
    expect(provider.listRunways).toHaveBeenCalledWith('ZJSY')
    expect(provider.listSids).toHaveBeenCalledWith('VHHH', '07R')
    expect(provider.listStars).toHaveBeenCalledWith('ZJSY', null)
    expect(provider.listApproaches).toHaveBeenCalledWith('ZJSY', '08')
    expect(provider.getProcedureWaypoints).toHaveBeenCalledWith('VHHH', 'sid', 'OCEAN2A', '07R', null)
    expect(provider.refreshTaxiNetwork).toHaveBeenCalledWith('ZJSY')
    expect(provider.hasTaxiNetwork).toHaveBeenCalledWith('ZJSY')
    expect(provider.getTaxiNetwork).toHaveBeenCalledWith('ZJSY')
  })

  it('treats a refresh the sim could not answer as an ordinary event: noted at info, never a failed handler', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    provider.refreshAirport.mockRejectedValueOnce(new Error('Open timeout'))
    provider.refreshTaxiNetwork.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    await expect(invoke(IpcChannels.navdataRefreshAirport, 'WSSS')).resolves.toBeUndefined()
    await expect(invoke(IpcChannels.navdataRefreshTaxiNetwork, 'WSSS')).resolves.toBeUndefined()
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('WSSS runways and procedures not refreshed: Error: Open timeout')
    )
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('WSSS taxi network not refreshed: Error: connect ECONNREFUSED')
    )
    info.mockRestore()
  })

  it('looks stands up only for a well-formed airport code, upper-cased', () => {
    expect(invoke(IpcChannels.navdataGetStands, 'zjsy')).toEqual([{ name: '12' }])
    expect(provider.getStands).toHaveBeenCalledWith('ZJSY')
    expect(invoke(IpcChannels.navdataGetStands, 'ZJSY; DROP')).toEqual([])
    expect(invoke(IpcChannels.navdataGetStands, 42)).toEqual([])
    expect(provider.getStands).toHaveBeenCalledTimes(1)
  })
})
