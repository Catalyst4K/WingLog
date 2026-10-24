import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight } from '../db/flight-repo'
import { fakeIpc } from '../ipc/fake-ipc'
import { registerPrefileHandlers } from './register-prefile-handlers'

const VATSIM_LINK = 'https://my.vatsim.net/pilots/flightplan?raw=x&fuel_time=0300'
const IVAO_LINK = 'https://fpl.ivao.aero/flight-plans/create?flightPlan=x'
const OFP = JSON.stringify({ prefile: { vatsim: { link: VATSIM_LINK }, ivao: { link: IVAO_LINK } } })
const HOSTILE_OFP = JSON.stringify({
  prefile: {
    vatsim: { link: 'https://evil.example/pilots/flightplan' },
    ivao: { link: 'file:///etc/passwd' }
  }
})

describe('prefile handlers', () => {
  let db: WingLogDb
  let openExternal: Mock<(url: string) => Promise<void>>
  let invoke: ReturnType<typeof fakeIpc>['invoke']

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    openExternal = vi.fn().mockResolvedValue(undefined)
    const ipc = fakeIpc()
    registerPrefileHandlers(ipc.ipcMain, { db, openExternal })
    invoke = ipc.invoke
  })

  function flightWith(ofpJson: string | null): number {
    const aircraft = createAircraft(db, { registration: 'G-TEST', icaoType: 'A320' })
    return createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'LFPG', ofpJson }).id
  }

  describe('from the OFP Dispatch holds', () => {
    it('opens VATSIM’s link for VATSIM and IVAO’s for IVAO', async () => {
      expect(await invoke(IpcChannels.onlinePrefileFromOfp, OFP, 'vatsim')).toBe(true)
      expect(await invoke(IpcChannels.onlinePrefileFromOfp, OFP, 'ivao')).toBe(true)
      expect(openExternal.mock.calls).toEqual([[VATSIM_LINK], [IVAO_LINK]])
    })

    it('opens nothing, and says so, for a link on the wrong host or scheme', async () => {
      expect(await invoke(IpcChannels.onlinePrefileFromOfp, HOSTILE_OFP, 'vatsim')).toBe(false)
      expect(await invoke(IpcChannels.onlinePrefileFromOfp, HOSTILE_OFP, 'ivao')).toBe(false)
      expect(openExternal).not.toHaveBeenCalled()
    })

    it.each([
      ['an OFP with no links', JSON.stringify({})],
      ['an OFP that is not JSON', 'nope'],
      ['no OFP', null],
      ['an OFP that is not text', 42]
    ])('opens nothing for %s', async (_name, ofp) => {
      expect(await invoke(IpcChannels.onlinePrefileFromOfp, ofp, 'vatsim')).toBe(false)
      expect(openExternal).not.toHaveBeenCalled()
    })

    it.each(['poscon', 'VATSIM', '', null, undefined, 3])('refuses the network %j', async (network) => {
      expect(await invoke(IpcChannels.onlinePrefileFromOfp, OFP, network)).toBe(false)
      expect(openExternal).not.toHaveBeenCalled()
    })
  })

  describe('for a saved flight', () => {
    it('reads the flight’s stored OFP and opens the chosen network’s link', async () => {
      const id = flightWith(OFP)
      expect(await invoke(IpcChannels.onlinePrefileForFlight, id, 'ivao')).toBe(true)
      expect(openExternal).toHaveBeenCalledWith(IVAO_LINK)
    })

    it('opens nothing for a flight with no OFP, an unknown flight, or a flight id that is not a number', async () => {
      const id = flightWith(null)
      expect(await invoke(IpcChannels.onlinePrefileForFlight, id, 'vatsim')).toBe(false)
      expect(await invoke(IpcChannels.onlinePrefileForFlight, 9999, 'vatsim')).toBe(false)
      expect(await invoke(IpcChannels.onlinePrefileForFlight, '1', 'vatsim')).toBe(false)
      expect(openExternal).not.toHaveBeenCalled()
    })

    it('opens nothing when the stored OFP’s link is hostile', async () => {
      const id = flightWith(HOSTILE_OFP)
      expect(await invoke(IpcChannels.onlinePrefileForFlight, id, 'vatsim')).toBe(false)
      expect(openExternal).not.toHaveBeenCalled()
    })
  })
})
