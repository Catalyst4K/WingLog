import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels, type AtcAreasCheck, type AtcAreasStatus } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { fakeIpc } from '../ipc/fake-ipc'
import { registerAtcAreas } from './atc-areas-handlers'
import { REAL_AREA_SOURCE } from './atc-areas-download'
import { bundledAtcAreas } from './bundled-atc-areas'
import { setOnlineNetworkSettings } from './online-settings'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0]
]
const HOST = 'https://github.com/vatsimnetwork/files/releases/download'

/** What a newer pair of community releases holds: as many areas as the bundled file, so it is plausible. */
function community(vatspyTag: string, traconTag: string): Record<string, string> {
  const held = bundledAtcAreas()
  const firCount = held?.firs.size ?? 0
  const approachCount = new Set([...(held?.approaches.values() ?? [])].map((a) => a.id)).size
  const firLines = Array.from({ length: firCount }, (_, i) => `F${i}|Area ${i}|F${i}|F${i}`)
  const dat = ['[FIRs]', ...firLines, '[UIRs]', ''].join('\r\n')
  const boundaries = JSON.stringify({
    features: Array.from({ length: firCount }, (_, i) => ({
      properties: { id: `F${i}`, label_lon: '0.5', label_lat: '0.5' },
      geometry: { type: 'Polygon', coordinates: [SQUARE] }
    }))
  })
  const tracon = JSON.stringify({
    features: Array.from({ length: approachCount }, (_, i) => ({
      properties: { id: `A${i}`, prefix: [`A${i}`], suffix: 'APP', name: `Approach ${i}` },
      geometry: { type: 'Polygon', coordinates: [SQUARE] }
    }))
  })
  return {
    [`${HOST}/${vatspyTag}/VATSpy.dat`]: dat,
    [`${HOST}/${vatspyTag}/Boundaries.geojson`]: boundaries,
    [`${HOST}/${traconTag}/TRACONBoundaries.geojson`]: tracon
  }
}

/** A `fetch` that answers as GitHub would for these releases. */
function fakeFetch(vatspyTag: string, traconTag: string, files: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const name = (tag: string, names: string[]) =>
      JSON.stringify({
        tag_name: tag,
        assets: names.map((n) => ({ name: n, browser_download_url: `${HOST}/${tag}/${n}` }))
      })
    if (url.includes('vatspy-data-project/releases/latest'))
      return new Response(name(vatspyTag, ['VATSpy.dat', 'Boundaries.geojson']))
    if (url.includes('simaware-tracon-project/releases/latest'))
      return new Response(name(traconTag, ['TRACONBoundaries.geojson']))
    const body = files[url]
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body)
  })
}

describe('the ATC areas update handlers', () => {
  let db: WingLogDb
  let dir: string
  let ipc: ReturnType<typeof fakeIpc>
  let stop: () => void
  let current: () => unknown

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    dir = mkdtempSync(join(tmpdir(), 'winglog-atc-areas-'))
    ipc = fakeIpc()
    const registered = registerAtcAreas(ipc.ipcMain, {
      db,
      userDataDir: dir,
      appVersion: '1.6.0',
      source: REAL_AREA_SOURCE
    })
    stop = registered.stop
    current = registered.current
  })

  afterEach(() => {
    stop()
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  const status = (): Promise<AtcAreasStatus> =>
    ipc.invoke(IpcChannels.atcAreasGetStatus) as Promise<AtcAreasStatus>

  it('starts on the bundled areas, with the switch on and nothing checked yet', async () => {
    expect(await status()).toMatchObject({ auto: true, source: 'bundled', checkedAt: null })
    expect(current()).toBe(bundledAtcAreas())
  })

  it('saves the switch, and ignores anything that is not a true or false', async () => {
    expect(await ipc.invoke(IpcChannels.atcAreasSetAuto, false)).toMatchObject({ auto: false })
    expect(await status()).toMatchObject({ auto: false })
    expect(await ipc.invoke(IpcChannels.atcAreasSetAuto, 'yes')).toMatchObject({ auto: false })
    expect(await ipc.invoke(IpcChannels.atcAreasSetAuto, true)).toMatchObject({ auto: true })
  })

  it('Check now downloads newer releases, keeps its own copy in the data folder, uses it, and sends only WingLog’s User-Agent', async () => {
    const fetchSpy = fakeFetch('v2999.1', 'v9.9.9', community('v2999.1', 'v9.9.9'))
    vi.stubGlobal('fetch', fetchSpy)
    const result = (await ipc.invoke(IpcChannels.atcAreasCheckNow)) as AtcAreasCheck
    expect(result.outcome).toBe('updated')
    expect(result.status).toMatchObject({ source: 'downloaded', vatspy: 'v2999.1', tracon: 'v9.9.9' })
    expect(result.status.checkedAt).not.toBeNull()
    expect(existsSync(join(dir, 'atc-areas.json'))).toBe(true)
    expect(existsSync(join(dir, 'atc-areas.json.tmp'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'atc-areas.json'), 'utf8')).sources).toEqual({
      vatspy: 'v2999.1',
      tracon: 'v9.9.9'
    })
    expect((current() as { sources: unknown }).sources).toEqual({ vatspy: 'v2999.1', tracon: 'v9.9.9' })
    for (const call of fetchSpy.mock.calls) {
      expect((call as unknown as [string, { headers: unknown }])[1].headers).toEqual({
        'User-Agent': 'WingLog/1.6.0 (+https://github.com/Catalyst4K/WingLog)'
      })
    }
  })

  it('reads its copy back on the next launch', async () => {
    vi.stubGlobal('fetch', fakeFetch('v2999.1', 'v9.9.9', community('v2999.1', 'v9.9.9')))
    await ipc.invoke(IpcChannels.atcAreasCheckNow)
    stop()
    const again = fakeIpc()
    const second = registerAtcAreas(again.ipcMain, {
      db,
      userDataDir: dir,
      appVersion: '1.6.0',
      source: REAL_AREA_SOURCE
    })
    expect(await again.invoke(IpcChannels.atcAreasGetStatus)).toMatchObject({
      source: 'downloaded',
      vatspy: 'v2999.1'
    })
    second.stop()
  })

  it('Check now says "current" when the releases are the ones in use, and writes nothing', async () => {
    const held = bundledAtcAreas()!
    vi.stubGlobal('fetch', fakeFetch(held.sources.vatspy, held.sources.tracon, {}))
    const result = (await ipc.invoke(IpcChannels.atcAreasCheckNow)) as AtcAreasCheck
    expect(result.outcome).toBe('current')
    expect(existsSync(join(dir, 'atc-areas.json'))).toBe(false)
  })

  it('Check now fails quietly when GitHub cannot be reached, leaving the bundled areas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const result = (await ipc.invoke(IpcChannels.atcAreasCheckNow)) as AtcAreasCheck
    expect(result.outcome).toBe('failed')
    expect(result.status).toMatchObject({ source: 'bundled', checkedAt: null })
  })

  it('ignores a copy in the data folder that is damaged', async () => {
    stop()
    writeFileSync(join(dir, 'atc-areas.json'), 'garbage')
    const again = fakeIpc()
    const second = registerAtcAreas(again.ipcMain, {
      db,
      userDataDir: dir,
      appVersion: '1.6.0',
      source: REAL_AREA_SOURCE
    })
    expect(await again.invoke(IpcChannels.atcAreasGetStatus)).toMatchObject({ source: 'bundled' })
    second.stop()
  })

  it('makes no scheduled request with no network chosen, and does with one', async () => {
    vi.useFakeTimers()
    try {
      stop()
      const fetchSpy = fakeFetch('v2610.1', 'v1.2.13', {})
      vi.stubGlobal('fetch', fetchSpy)
      const first = registerAtcAreas(fakeIpc().ipcMain, {
        db,
        userDataDir: dir,
        appVersion: '1.6.0',
        source: REAL_AREA_SOURCE
      })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(fetchSpy).not.toHaveBeenCalled()
      first.stop()
      setOnlineNetworkSettings(db, {
        network: 'vatsim',
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      })
      const second = registerAtcAreas(fakeIpc().ipcMain, {
        db,
        userDataDir: dir,
        appVersion: '1.6.0',
        source: REAL_AREA_SOURCE
      })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      second.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
