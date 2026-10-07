import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createAircraft } from './aircraft-repo'
import { createDb, type WingLogDb } from './client'
import { dbFlightStore } from './flight-store'
import { completeFlight, createFlight, startFlight } from './flight-repo'
import { setGsxSettings } from './settings-repo'
import { logger } from '../logging/logger'

const scanGsxFolder = vi.fn()
vi.mock('../gsx/scan', () => ({ scanGsxFolder: (...args: unknown[]) => scanGsxFolder(...args) }))

describe('dbFlightStore.saveGsxInvoices', () => {
  let db: WingLogDb
  let flightId: number

  beforeEach(() => {
    vi.clearAllMocks()
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    const aircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    flightId = createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' }).id
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
    startFlight(db, flightId, 6000)
    vi.setSystemTime(new Date('2026-09-06T13:00:00Z'))
    completeFlight(db, flightId, 3000)
    vi.useRealTimers()
  })

  it('does nothing while GSX is off', () => {
    dbFlightStore(db).saveGsxInvoices(flightId)
    expect(scanGsxFolder).not.toHaveBeenCalled()
  })

  it('logs a failed scan and lets the flight stand', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    setGsxSettings(db, { enabled: true, folderPath: 'C:/GSX', displayCurrency: 'USD' })
    scanGsxFolder.mockRejectedValue(new Error('folder renamed'))
    dbFlightStore(db).saveGsxInvoices(flightId)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    expect(warn.mock.calls[0]?.[0]).toContain('folder renamed')
    warn.mockRestore()
  })
})
