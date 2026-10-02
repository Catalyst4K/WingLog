import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft, deleteAircraft } from '../db/aircraft-repo'
import { getSetupContext, getSetupState, isListening, setSetupCompleted } from './first-run'

vi.mock('../gsx/default-path', () => ({ defaultGsxReceiptsPath: () => null }))

describe('first-launch setup state (first-launch-setup.md)', () => {
  let db: WingLogDb
  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  it('shows the setup to a new install until it is completed or closed', () => {
    expect(getSetupState(db)).toEqual({ show: true, whatsNew: false })
    expect(getSetupState(db)).toEqual({ show: true, whatsNew: false })
    setSetupCompleted(db)
    expect(getSetupState(db)).toEqual({ show: false, whatsNew: false })
  })

  it("gives someone upgrading with a fleet a one-off what's-new instead of the setup", () => {
    createAircraft(db, { registration: 'B-LRA', icaoType: 'A359' })
    expect(getSetupState(db)).toEqual({ show: false, whatsNew: true })
    expect(getSetupState(db)).toEqual({ show: false, whatsNew: false })
  })

  it('treats a deleted-only fleet as a new install', () => {
    const plane = createAircraft(db, { registration: 'B-LRA', icaoType: 'A359' })
    deleteAircraft(db, plane.id)
    expect(getSetupState(db)).toEqual({ show: true, whatsNew: false })
  })
})

describe('getSetupContext', () => {
  it("reports BeyondATC running from a local probe, and GSX's folder as missing when there isn't one", async () => {
    const probe = vi.fn().mockResolvedValue(true)
    expect(await getSetupContext(probe)).toEqual({ gsxFolderFound: false, gsxFolderPath: null, beyondAtcRunning: true })
    expect(probe).toHaveBeenCalledWith('127.0.0.1', 41716)
  })
})

describe('isListening', () => {
  it('is true for an open local port and false for a closed one', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    expect(await isListening('127.0.0.1', port)).toBe(true)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await isListening('127.0.0.1', port)).toBe(false)
  })
})
