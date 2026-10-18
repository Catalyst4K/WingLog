import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { logger } from '../logging/logger'
import { createAircraft } from './aircraft-repo'
import { createDb, type WingLogDbHandle } from './client'
import { createFlight, getFlight } from './flight-repo'
import { runStorageMaintenance, startStorageMaintenance } from './storage-maintenance'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const ofp = (tag: string): string =>
  JSON.stringify({
    tag,
    navlog: { fix: Array.from({ length: 70_000 }, (_, i) => ({ ident: `FIX${i}`, via: 'UL9' })) }
  })

describe('storage maintenance', () => {
  let dir: string
  let handle: WingLogDbHandle
  let ids: number[]

  beforeEach(() => {
    vi.mocked(logger.info).mockClear()
    dir = mkdtempSync(join(tmpdir(), 'winglog-maintenance-'))
    handle = createDb(join(dir, 'winglog.db'))
    migrate(handle.db, { migrationsFolder: 'drizzle' })
    const aircraftId = createAircraft(handle.db, { registration: 'G-ABCD', icaoType: 'A320' }).id
    ids = Array.from({ length: 12 }, (_, i) => {
      const id = createFlight(handle.db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC' }).id
      handle.sqlite.prepare('UPDATE flight SET ofp_json = ? WHERE id = ?').run(ofp(String(i)), id)
      return id
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    handle.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('compresses the plain-text OFPs, compacts the file, and logs both', async () => {
    await runStorageMaintenance(handle.sqlite, true)
    const messages = vi.mocked(logger.info).mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.startsWith('[storage] compressed 12 OFPs'))).toBe(true)
    expect(messages.some((m) => m.startsWith('[storage] database file'))).toBe(true)
    ids.forEach((id, i) => expect(getFlight(handle.db, id)?.ofpJson).toBe(ofp(String(i))))
  })

  it('compresses but does not compact the file when this launch has no backup', async () => {
    await runStorageMaintenance(handle.sqlite, false)
    const messages = vi.mocked(logger.info).mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.startsWith('[storage] compressed 12 OFPs'))).toBe(true)
    expect(messages.some((m) => m.startsWith('[storage] database file'))).toBe(false)
  })

  it('says nothing on a launch with nothing to do', async () => {
    await runStorageMaintenance(handle.sqlite, true)
    vi.mocked(logger.info).mockClear()
    await runStorageMaintenance(handle.sqlite, true)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('starts a few seconds after launch, not at once', async () => {
    vi.useFakeTimers()
    startStorageMaintenance(handle.sqlite, true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(logger.info).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6_000)
    vi.useRealTimers()
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalled())
  })
})
