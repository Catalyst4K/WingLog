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
import { createLan } from './create-lan'

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

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
      trackingController: { getActive: () => undefined },
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
      trackingController: { getActive: () => undefined },
      pageFolder: tmpdir()
    })
    const addresses = real.getStatus().addresses
    expect(addresses.every((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a.address))).toBe(true)
    expect(addresses.map((a) => a.address)).not.toContain('127.0.0.1')
  })
})
