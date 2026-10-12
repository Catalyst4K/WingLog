import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { WebSocket } from 'ws'
import { createDb } from '../db/client'
import { setLanSettings } from '../db/settings-repo'
import { LiveHub } from '../live/LiveHub'
import type { LanController } from './LanController'
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
  refreshTaxiNetwork: () => Promise.resolve(),
  getTaxiNetwork: (icao: string) => [{ icao }] as never,
  getStands: (icao: string) => Promise.resolve([{ icao }] as never),
  refreshAirport: () => Promise.resolve(),
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

const TRACKING = {
  getActive: () => undefined,
  getProcedureSelection: () => undefined,
  setProcedureSelection: () => undefined
}

const LOCAL = {
  display: () => ({ weightUnit: 'kg', altitudeUnit: 'ft', windSpeedUnit: 'kt', mapLanguage: 'en' }),
  addOns: () => ({ gsxRemote: true, beyondAtc: false }),
  metars: (codes: unknown) => Promise.resolve([{ asked: codes }])
}

const CREATE_DEPS = { navdata: NAVDATA, addOnCommands: {}, userAgent: 'WingLog/test' }

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

  it('looks up weather for a few airports, and refuses anything else', async () => {
    await expect(queries['weather.metars'](['WSSS', 'EGLL'])).resolves.toEqual([{ asked: ['WSSS', 'EGLL'] }])
    expect(() => queries['weather.metars']('WSSS')).toThrow('Invalid airports')
    expect(() => queries['weather.metars'](['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toThrow('Invalid airports')
  })

  it('answers the taxi chart, stands and refresh for an airport code', async () => {
    expect(queries['taxi.has']('WSSS')).toBe(true)
    expect(queries['taxi.has']('EGLL')).toBe(false)
    expect(queries['taxi.get']('WSSS')).toEqual([{ icao: 'WSSS' }])
    await expect(queries.stands('K1B2')).resolves.toEqual([{ icao: 'K1B2' }])
    await expect(queries['taxi.refresh']('EGLL')).resolves.toBeUndefined()
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
    await expect(queries['navdata.refreshAirport']('WSSS')).resolves.toBeUndefined()
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
      ...CREATE_DEPS,
      pageFolder,
      testAddress: '127.0.0.1'
    })
    return { db, hub, lan }
  }

  it('stays off until the settings say otherwise', async () => {
    const { lan } = build()
    await lan.init()
    expect(lan.getStatus()).toMatchObject({ listening: false, url: null, devices: [] })
  })

  it('serves the built page and pairs a device once switched on, keeping only its token hash', async () => {
    const { db, hub, lan } = build()
    const port = await freePort()
    setLanSettings(db, { enabled: true, adapter: null, port })
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

  it('is given the machine’s own addresses when no test address is passed', async () => {
    const { db } = createDb(':memory:')
    migrate(db, { migrationsFolder: 'drizzle' })
    const real = createLan({
      db,
      liveHub: new LiveHub(),
      trackingController: TRACKING,
      ...CREATE_DEPS,
      pageFolder: tmpdir()
    })
    const addresses = real.getStatus().addresses
    expect(addresses.every((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a.address))).toBe(true)
    expect(addresses.map((a) => a.address)).not.toContain('127.0.0.1')
  })
})
