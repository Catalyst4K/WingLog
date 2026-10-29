import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { WebSocket } from 'ws'
import { createDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight } from '../db/flight-repo'
import { setAppLanguage, setLanSettings, setTheme } from '../db/settings-repo'
import { LiveHub } from '../live/LiveHub'
import type { LanController } from './LanController'
import { LAN_QUERY_KINDS } from '@shared/lan-queries'
import { createLan, lanQueries } from './create-lan'

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const NAVDATA = {
  hasTaxiNetwork: (icao: string) => icao === 'WSSS',
  getTaxiNetwork: (icao: string) => [{ icao }] as never,
  getStands: (icao: string) => Promise.resolve([{ icao }] as never),
  onAirportRefreshed: () => () => undefined,
  listRunways: (icao: string) => [{ ident: '02L', icao }] as never,
  listSids: (icao: string, runway: string | null) => [{ kind: 'sid', icao, runway }] as never,
  listStars: (icao: string, runway: string | null) => [{ kind: 'star', icao, runway }] as never,
  listApproaches: (icao: string, runway: string | null) => [{ kind: 'approach', icao, runway }] as never,
  getProcedureWaypoints: (
    icao: string,
    kind: string,
    identifier: string,
    runway: string | null,
    transition: string | null
  ) => [{ icao, kind, identifier, runway, transition }] as never
}

const TRACKING = Object.assign(new EventEmitter(), { getActive: () => undefined }) as never

/** The procedure selection store as the second screen sees it: the choice held, and a change (only) announced. */
function fakeSelection(): EventEmitter & { current: () => unknown; set: (selection: unknown) => void } {
  const emitter = new EventEmitter()
  let current: unknown
  return Object.assign(emitter, {
    current: () => current,
    set: (selection: unknown) => {
      if (JSON.stringify(current) === JSON.stringify(selection)) return
      current = selection
      emitter.emit('changed', selection)
    }
  })
}

const LOCAL = {
  display: () => ({ weightUnit: 'kg', altitudeUnit: 'ft', windSpeedUnit: 'kt', mapLanguage: 'en' }),
  addOns: () => ({ gsxRemote: true, beyondAtc: false }),
  metars: (codes: unknown) => Promise.resolve([{ asked: codes }]),
  atis: (requests: unknown) => Promise.resolve({ network: 'vatsim', asked: requests })
}

const CREATE_DEPS = { navdata: NAVDATA, addOnCommands: {}, userAgent: 'WingLog/test', atis: LOCAL.atis }

describe('lanQueries', () => {
  const queries = lanQueries(NAVDATA, LOCAL)

  it("answers the PC's unit settings and which add-ons are on, never their host or port", () => {
    expect(queries['settings.display']()).toEqual({
      weightUnit: 'kg',
      altitudeUnit: 'ft',
      windSpeedUnit: 'kt',
      mapLanguage: 'en'
    })
    expect(queries['settings.gsxRemote']()).toEqual({ enabled: true, host: '', port: 1 })
    expect(queries['settings.beyondAtc']()).toEqual({ enabled: false, host: '' })
  })

  it('has every lookup placed in a lane in the shared table, and nothing in the table that it does not answer', () => {
    expect(Object.keys(queries).sort()).toEqual(Object.keys(LAN_QUERY_KINDS).sort())
  })

  it('looks up weather for a few airports, and refuses anything else', async () => {
    await expect(queries['weather.metars'](['WSSS', 'EGLL'])).resolves.toEqual([{ asked: ['WSSS', 'EGLL'] }])
    expect(() => queries['weather.metars']('WSSS')).toThrow('Invalid airports')
    expect(() => queries['weather.metars'](['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toThrow('Invalid airports')
  })

  it('hands the weather panel’s ATIS request to the PC’s own lookup, which does the checking', async () => {
    const asked = [{ icao: 'EGLL', slot: 'departure' }]
    await expect(queries['online.atis'](asked)).resolves.toEqual({ network: 'vatsim', asked })
  })

  it('answers the taxi chart, stands and refresh for an airport code', async () => {
    expect(queries['taxi.has']('WSSS')).toBe(true)
    expect(queries['taxi.has']('EGLL')).toBe(false)
    expect(queries['taxi.get']('WSSS')).toEqual([{ icao: 'WSSS' }])
    await expect(queries.stands('K1B2')).resolves.toEqual([{ icao: 'K1B2' }])
  })

  it('never makes the PC fetch from the sim for a device: the refresh lookups answer at once and do nothing', () => {
    // The provider here has no refresh methods at all, so a call that reached one would throw.
    expect(queries['taxi.refresh']('EGLL')).toBeUndefined()
    expect(queries['navdata.refreshAirport']('WSSS')).toBeUndefined()
    expect(() => queries['taxi.refresh']('../x')).toThrow('Invalid airport')
    expect(() => queries['navdata.refreshAirport'](5)).toThrow('Invalid airport')
  })

  it('lists the airfields', () => {
    expect(Array.isArray(queries.airfields(undefined))).toBe(true)
  })

  it('answers the runways and procedures for the Procedures dialog', async () => {
    expect(queries['navdata.listRunways']('WSSS')).toEqual([{ ident: '02L', icao: 'WSSS' }])
    expect(queries['navdata.listSids']('WSSS', '02L')).toEqual([{ kind: 'sid', icao: 'WSSS', runway: '02L' }])
    expect(queries['navdata.listStars']('WSSS')).toEqual([{ kind: 'star', icao: 'WSSS', runway: null }])
    expect(queries['navdata.listApproaches']('WSSS', null)).toEqual([
      { kind: 'approach', icao: 'WSSS', runway: null }
    ])
    expect(queries['navdata.procedureWaypoints']('WSSS', 'star', 'TEBU1B', '20R', undefined)).toEqual([
      { icao: 'WSSS', kind: 'star', identifier: 'TEBU1B', runway: '20R', transition: null }
    ])
  })

  it('refuses a procedure query with a bad airport, kind, name or runway', () => {
    expect(() => queries['navdata.listSids']('WSSS', 5)).toThrow('Invalid name')
    expect(() => queries['navdata.listSids']('WSSS', 'x'.repeat(41))).toThrow('Invalid name')
    expect(() => queries['navdata.listSids']('../x', null)).toThrow('Invalid airport')
    expect(() => queries['navdata.procedureWaypoints']('WSSS', 'taxi', 'X', null, null)).toThrow(
      'Invalid procedure'
    )
    expect(() => queries['navdata.procedureWaypoints']('WSSS', 'star', '', null, null)).toThrow(
      'Invalid name'
    )
    expect(() => queries['navdata.procedureWaypoints']('WSSS', 'star', null, null, null)).toThrow(
      'Invalid procedure'
    )
  })

  it('refuses anything that is not an airport code', () => {
    for (const bad of [undefined, null, 5, '', 'ab', 'wsss', 'WSSSS', '../etc', {}, ['WSSS']]) {
      expect(() => queries['taxi.get'](bad)).toThrow('Invalid airport')
    }
  })
})

describe('createLan', () => {
  const folders: string[] = []
  let lan: LanController | null = null

  afterEach(async () => {
    await lan?.stop()
    lan = null
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })

  function build() {
    const { db } = createDb(':memory:')
    migrate(db, { migrationsFolder: 'drizzle' })
    const pageFolder = mkdtempSync(join(tmpdir(), 'winglog-lan-'))
    folders.push(pageFolder)
    writeFileSync(join(pageFolder, 'index.html'), '<div id="root"></div>')
    const hub = new LiveHub()
    lan = createLan({
      db,
      liveHub: hub,
      trackingController: TRACKING,
      selection: fakeSelection() as never,
      ...CREATE_DEPS,
      systemLocale: () => 'de-DE',
      pageFolder,
      testAddress: '127.0.0.1'
    })
    return { db, hub, lan }
  }

  it('builds the route of the flight shown, and builds it again when the choice, the navdata or the flight changes', async () => {
    const { db, hub } = build()
    let refreshed: ((icao: string) => void) | undefined
    const tracking = Object.assign(new EventEmitter(), { getActive: () => undefined })
    const selection = fakeSelection()
    const sent: { revision: number; selection: { sidIdent: string | null } }[] = []
    hub.subscribe((topic, payload) => {
      if (topic === 'plannedRoute' && payload) sent.push(payload as never)
    })
    const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
    createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'KJFK' })
    await lan?.stop()
    lan = createLan({
      db,
      liveHub: hub,
      trackingController: tracking as never,
      selection: selection as never,
      ...CREATE_DEPS,
      navdata: {
        ...NAVDATA,
        onAirportRefreshed: (listener: (icao: string) => void) => {
          refreshed = listener
          return () => undefined
        }
      },
      pageFolder: folders[0],
      testAddress: '127.0.0.1'
    })
    // Built at once for the flight shown.
    expect(sent).toHaveLength(1)
    expect(hub.snapshot().plannedRoute).toMatchObject({ revision: 1 })

    // A choice made on any screen.
    selection.set({
      departureRunway: '27L',
      sidIdent: 'BPK7F',
      sidTransition: null,
      starIdent: null,
      starTransition: null,
      approachIdent: null,
      approachTransition: null,
      arrivalIcao: null
    })
    expect(sent.map((r) => r.revision)).toEqual([1, 2])
    expect(sent[1].selection.sidIdent).toBe('BPK7F')

    // Nothing changed: nothing more is sent, whatever asks.
    tracking.emit('started', 1)
    tracking.emit('stopped', 1)
    tracking.emit('completed', 1)
    refreshed?.('EGLL')
    expect(sent).toHaveLength(2)
  })

  it('answers a choice from a device with the route built for it, even when the PC already had that choice', async () => {
    const { db, hub } = build()
    const selection = fakeSelection()
    const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
    createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'KJFK' })
    await lan?.stop()
    lan = createLan({
      db,
      liveHub: hub,
      trackingController: TRACKING,
      selection: selection as never,
      ...CREATE_DEPS,
      pageFolder: folders[0],
      testAddress: '127.0.0.1'
    })
    const port = await freePort()
    setLanSettings(db, { enabled: true, port })
    await lan.init()
    const { code } = lan.startPairing().pairing!
    const messages: Record<string, unknown>[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`)
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    ws.send(JSON.stringify({ t: 'pair', code, name: 'Phone' }))
    await expect.poll(() => messages.some((m) => m.t === 'snapshot')).toBe(true)
    const routes = () => messages.filter((m) => m.t === 'topic' && m.name === 'plannedRoute')
    const choice = {
      departureRunway: '27L',
      sidIdent: 'BPK7F',
      sidTransition: null,
      starIdent: null,
      starTransition: null,
      approachIdent: null,
      approachTransition: null,
      arrivalIcao: null
    }

    ws.send(JSON.stringify({ t: 'cmd', name: 'track.setProcedureSelection', args: [choice] }))
    await expect.poll(() => routes().length).toBe(1)
    expect(routes()[0]).toMatchObject({ payload: { revision: 2, selection: { sidIdent: 'BPK7F' } } })

    // The same choice again: nothing changed on the PC, and the device is still answered, with the same route.
    ws.send(JSON.stringify({ t: 'cmd', name: 'track.setProcedureSelection', args: [choice] }))
    await expect.poll(() => routes().length).toBe(2)
    expect(routes()[1]).toEqual(routes()[0])
    ws.terminate()
  })

  it('stays off until the settings say otherwise', async () => {
    const { lan } = build()
    await lan.init()
    expect(lan.getStatus()).toMatchObject({ listening: false, url: null, devices: [] })
  })

  it("tells a paired device how the PC looks: its language and theme, and the OS language 'system' means", async () => {
    const { db, lan } = build()
    setAppLanguage(db, 'system')
    setTheme(db, 'dark')
    const port = await freePort()
    setLanSettings(db, { enabled: true, port })
    await lan.init()
    const { code } = lan.startPairing().pairing!
    const messages: Record<string, unknown>[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`)
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    ws.send(JSON.stringify({ t: 'pair', code, name: 'iPhone (Safari)' }))
    await expect.poll(() => messages.some((m) => m.t === 'snapshot')).toBe(true)

    ws.send(JSON.stringify({ t: 'query', id: 7, name: 'settings.display', args: [] }))
    await expect.poll(() => messages.some((m) => m.t === 'result' && m.id === 7)).toBe(true)
    expect(messages.find((m) => m.t === 'result' && m.id === 7)).toMatchObject({
      data: { appLanguage: 'system', theme: 'dark', systemLocale: 'de-DE', mapLanguage: 'en' }
    })
    ws.terminate()
  })

  it('serves the built page and pairs a device once switched on, keeping only its token hash', async () => {
    const { db, hub, lan } = build()
    const port = await freePort()
    setLanSettings(db, { enabled: true, port })
    await lan.init()
    expect(lan.getStatus().url).toBe(`http://127.0.0.1:${port}/`)

    const page = await fetch(`http://127.0.0.1:${port}/`)
    expect(await page.text()).toBe('<div id="root"></div>')

    const { code } = lan.startPairing().pairing!
    const messages: Record<string, unknown>[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`)
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    ws.send(JSON.stringify({ t: 'pair', code, name: 'iPad (Safari)' }))
    await expect.poll(() => messages.some((m) => m.t === 'snapshot')).toBe(true)
    expect(messages[0]).toMatchObject({ t: 'paired' })
    expect(lan.getStatus().devices).toMatchObject([{ name: 'iPad (Safari)' }])

    hub.publish('simConnectionStatus', { state: 'connected', lastError: null } as never)
    await expect
      .poll(() => messages.some((m) => m.t === 'topic' && m.name === 'simConnectionStatus'))
      .toBe(true)

    // The snapshot has no flight when nothing is tracked, and a later hello is recognised by its token.
    expect(messages.find((m) => m.t === 'snapshot')).toMatchObject({ flight: null })
    const token = (messages[0] as { token: string }).token
    const again: Record<string, unknown>[] = []
    const second = new WebSocket(`ws://127.0.0.1:${port}/live`)
    second.on('message', (data) => again.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve) => second.once('open', () => resolve()))
    second.send(JSON.stringify({ t: 'hello', token }))
    await expect.poll(() => again.some((m) => m.t === 'snapshot')).toBe(true)
    expect(lan.getStatus().devices[0].lastSeenAt).not.toBeNull()

    lan.revokeDevice(lan.getStatus().devices[0].id)
    expect(lan.getStatus().devices).toEqual([])
    ws.terminate()
    second.terminate()
  })
})
