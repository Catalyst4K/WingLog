import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels, type DispatchOfp, type DispatchOpenSimBriefParams } from '@shared/ipc'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { createFlight } from '../db/flight-repo'
import { setSimbriefUsername } from '../db/settings-repo'
import { parseOfp, type SimBriefOfp } from '../simbrief/simbrief-client'
import { registerDispatchHandlers, simbriefAirframeUrl, simbriefPrefillUrl } from './dispatch-handlers'
import { fakeIpc } from './fake-ipc'

const openExternal = vi.fn()
vi.mock('electron', () => ({ shell: { openExternal: (url: string) => openExternal(url) } }))
const fetchLatestOfp = vi.fn<(username: string) => Promise<SimBriefOfp>>()
vi.mock('../simbrief/simbrief-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../simbrief/simbrief-client')>()),
  fetchLatestOfp: (username: string) => fetchLatestOfp(username)
}))
const generateOfp = vi.fn()
const loginToSimbrief = vi.fn()
vi.mock('../simbrief/simbrief-generate', () => ({
  generateOfp: (params: unknown) => generateOfp(params),
  loginToSimbrief: () => loginToSimbrief(),
  isSimbriefLoggedIn: () => true,
  logoutOfSimbrief: () => undefined,
  fetchSimbriefUsername: () => 'pilot123'
}))

/** A SimBrief OFP in its real field names (see simbrief-client.test.ts), not real flight data. */
function rawOfp(requestId: string): unknown {
  return {
    fetch: { status: 'Success' },
    params: { request_id: requestId, units: 'kgs' },
    origin: { icao_code: 'VHHH' },
    destination: { icao_code: 'ZJSY' },
    general: { icao_airline: 'CPA', flight_number: '230', route: 'DCT', initial_altitude: '33000' },
    aircraft: { icaocode: 'A320', reg: 'B-HSL', internal_id: 'A320', is_custom: '0' },
    weights: { pax_count: '150', cargo: '2000', est_zfw: '60000', est_tow: '66000', est_ldw: '62000' },
    fuel: { plan_ramp: '6000' },
    times: { sched_out: '1787860800', sched_in: '1787865000' }
  }
}

const HKG_SYX: DispatchOpenSimBriefParams = {
  origIcao: 'VHHH',
  destIcao: 'ZJSY',
  icaoType: 'A320',
  simbriefAirframeId: null
}

describe('simbriefPrefillUrl', () => {
  it('falls back to the SimBrief home page without a route and an aircraft', () => {
    expect(simbriefPrefillUrl({ ...HKG_SYX, destIcao: '' })).toBe('https://dispatch.simbrief.com/')
    expect(simbriefPrefillUrl({ ...HKG_SYX, icaoType: '' })).toBe('https://dispatch.simbrief.com/')
  })

  it('prefers a saved airframe, then a chosen SimBrief type, then the ICAO type', () => {
    expect(simbriefPrefillUrl(HKG_SYX)).toBe(
      'https://dispatch.simbrief.com/options/custom?orig=VHHH&dest=ZJSY&type=A320'
    )
    expect(simbriefPrefillUrl({ ...HKG_SYX, simbriefType: 'A20N' })).toContain('&type=A20N')
    expect(simbriefPrefillUrl({ ...HKG_SYX, simbriefType: 'A20N', simbriefAirframeId: '123_456' })).toContain(
      '&airframe=123_456'
    )
  })

  it('appends only the prefills that are set, encoding every value', () => {
    const url = simbriefPrefillUrl({
      ...HKG_SYX,
      airlineIcao: 'CPA',
      flightNumber: '230',
      departure: { dateEpochSeconds: 1787860800, hour: 8, minute: 5 },
      extra: [
        ['pax', '150'],
        ['route', 'DCT &evil=1']
      ]
    })
    expect(url).toBe(
      'https://dispatch.simbrief.com/options/custom?orig=VHHH&dest=ZJSY&type=A320' +
        '&airline=CPA&fltnum=230&date=1787860800&deph=8&depm=5&pax=150&route=DCT%20%26evil%3D1'
    )
  })
})

describe('simbriefAirframeUrl', () => {
  it("opens the saved airframe's editor by the ID's suffix, or the list without one", () => {
    expect(simbriefAirframeUrl('123456_1787860800123')).toBe(
      'https://dispatch.simbrief.com/airframes/saved/1787860800123'
    )
    expect(simbriefAirframeUrl('malformed')).toBe('https://dispatch.simbrief.com/airframes')
    expect(simbriefAirframeUrl(null)).toBe('https://dispatch.simbrief.com/airframes')
  })
})

describe('dispatch IPC handlers', () => {
  let db: WingLogDb
  let invoke: ReturnType<typeof fakeIpc>['invoke']

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    openExternal.mockReset()
    fetchLatestOfp.mockReset()
    generateOfp.mockReset()
    const ipc = fakeIpc()
    invoke = ipc.invoke
    registerDispatchHandlers(ipc.ipcMain, { db })
  })

  it('needs a SimBrief username before fetching or generating', async () => {
    await expect(invoke(IpcChannels.dispatchFetchOfp)).rejects.toThrow()
    await expect(invoke(IpcChannels.dispatchGenerateOfp, HKG_SYX)).rejects.toThrow()
    expect(fetchLatestOfp).not.toHaveBeenCalled()
  })

  it('fetches the latest OFP and matches it to the fleet by registration', async () => {
    setSimbriefUsername(db, 'pilot123')
    const aircraft = createAircraft(db, { registration: 'B-HSL', icaoType: 'A320' })
    fetchLatestOfp.mockResolvedValueOnce(parseOfp(rawOfp('111')))
    const ofp = (await invoke(IpcChannels.dispatchFetchOfp)) as DispatchOfp
    expect(fetchLatestOfp).toHaveBeenCalledWith('pilot123')
    expect(ofp.ofpId).toBe('111')
    expect(ofp.matchedAircraftId).toBe(aircraft.id)
    expect(JSON.parse(ofp.ofpJson)).toMatchObject({ params: { request_id: '111' } })
  })

  it('generates a plan, and fails when SimBrief still shows the old one', async () => {
    setSimbriefUsername(db, 'pilot123')
    fetchLatestOfp
      .mockResolvedValueOnce(parseOfp(rawOfp('111')))
      .mockResolvedValueOnce(parseOfp(rawOfp('222')))
    expect(((await invoke(IpcChannels.dispatchGenerateOfp, HKG_SYX)) as DispatchOfp).ofpId).toBe('222')
    expect(generateOfp).toHaveBeenCalledWith(HKG_SYX)

    fetchLatestOfp
      .mockResolvedValueOnce(parseOfp(rawOfp('222')))
      .mockResolvedValueOnce(parseOfp(rawOfp('222')))
    await expect(invoke(IpcChannels.dispatchGenerateOfp, HKG_SYX)).rejects.toThrow()
  })

  it('generates the first plan for a pilot with none on SimBrief yet', async () => {
    setSimbriefUsername(db, 'pilot123')
    fetchLatestOfp
      .mockRejectedValueOnce(new Error('No flight plan'))
      .mockResolvedValueOnce(parseOfp(rawOfp('111')))
    expect(((await invoke(IpcChannels.dispatchGenerateOfp, HKG_SYX)) as DispatchOfp).ofpId).toBe('111')
  })

  it("restores the in-progress flight's plan, and nothing when its stored OFP is unreadable", () => {
    const aircraft = createAircraft(db, { registration: 'B-HSL', icaoType: 'A320' })
    expect(invoke(IpcChannels.dispatchGetInProgressFlight)).toBeNull()
    const planned = createFlight(db, {
      aircraftId: aircraft.id,
      depIcao: 'VHHH',
      arrIcao: 'ZJSY',
      ofpJson: JSON.stringify(rawOfp('111'))
    })
    expect(invoke(IpcChannels.dispatchGetInProgressFlight)).toMatchObject({
      flight: { id: planned.id },
      ofp: { ofpId: '111', matchedAircraftId: aircraft.id }
    })

    const other = createDb(':memory:').db
    migrate(other, { migrationsFolder: 'drizzle' })
    createFlight(other, {
      aircraftId: createAircraft(other, { registration: 'B-HSL', icaoType: 'A320' }).id,
      depIcao: 'VHHH',
      arrIcao: 'ZJSY',
      ofpJson: '{not json'
    })
    const ipc = fakeIpc()
    registerDispatchHandlers(ipc.ipcMain, { db: other })
    expect(ipc.invoke(IpcChannels.dispatchGetInProgressFlight)).toBeNull()
  })

  it('opens SimBrief pages, and the OFP PDF only from a valid SimBrief link', async () => {
    invoke(IpcChannels.dispatchOpenSimBrief, HKG_SYX)
    invoke(IpcChannels.dispatchOpenSimBriefAirframes, null)
    expect(openExternal.mock.calls).toEqual([
      ['https://dispatch.simbrief.com/options/custom?orig=VHHH&dest=ZJSY&type=A320'],
      ['https://dispatch.simbrief.com/airframes']
    ])
    expect(await invoke(IpcChannels.dispatchOpenOfpPdf, '{not json')).toBe(false)
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('passes the SimBrief login channels through, and always offers generation', () => {
    invoke(IpcChannels.dispatchLoginSimbrief)
    expect(loginToSimbrief).toHaveBeenCalled()
    expect(invoke(IpcChannels.dispatchSimbriefLoginStatus)).toBe(true)
    expect(invoke(IpcChannels.dispatchFetchSimbriefUsername)).toBe('pilot123')
    expect(invoke(IpcChannels.dispatchLogoutSimbrief)).toBeUndefined()
    expect(invoke(IpcChannels.dispatchGenerationAvailable)).toBe(true)
  })
})
