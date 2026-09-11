import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BrowserWindow } from 'electron'
import { createDb, type WingLogDb } from './client'
import { listAircraft } from './aircraft-repo'
import { listFlights } from './flight-repo'
import { importLogbookCsv } from './logbook-import'

const { showOpenDialog } = vi.hoisted(() => ({ showOpenDialog: vi.fn() }))

vi.mock('electron', () => ({
  dialog: { showOpenDialog }
}))

const FAKE_WINDOW = {} as BrowserWindow

const HEADER =
  'DepartureICAO,ArrivalICAO,AircraftReg,AirframeICAO,Callsign,FlightNo,Network,' +
  'DepDate (DD/MM/YY),DepTime (HHMM),ArrDate (DD/MM/YY),ArrTime (HHMM)'

function stkpRow(overrides: Partial<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    DepartureICAO: 'EGLL',
    ArrivalICAO: 'EGCC',
    AircraftReg: 'G-ABCD',
    AirframeICAO: 'A320',
    Callsign: '',
    FlightNo: 'BA100',
    Network: '',
    'DepDate (DD/MM/YY)': '21/08/2026',
    'DepTime (HHMM)': '1200',
    'ArrDate (DD/MM/YY)': '21/08/2026',
    'ArrTime (HHMM)': '1315',
    ...overrides
  }
  return [
    fields.DepartureICAO,
    fields.ArrivalICAO,
    fields.AircraftReg,
    fields.AirframeICAO,
    fields.Callsign,
    fields.FlightNo,
    fields.Network,
    fields['DepDate (DD/MM/YY)'],
    fields['DepTime (HHMM)'],
    fields['ArrDate (DD/MM/YY)'],
    fields['ArrTime (HHMM)']
  ].join(',')
}

describe('importLogbookCsv', () => {
  let db: WingLogDb
  let dir: string

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    dir = mkdtempSync(join(tmpdir(), 'winglog-logbook-import-'))
    showOpenDialog.mockReset()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when the open dialog is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await importLogbookCsv(db, FAKE_WINDOW)).toBeNull()
  })

  it('imports a row, auto-creating the aircraft it references', async () => {
    const filePath = join(dir, 'logbook.csv')
    writeFileSync(filePath, `${HEADER}\n${stkpRow()}\n`, 'utf-8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

    const summary = await importLogbookCsv(db, FAKE_WINDOW)

    expect(summary).toEqual({ imported: 1, aircraftCreated: 1, skipped: [] })
    expect(listAircraft(db).map((a) => a.registration)).toEqual(['G-ABCD'])
    expect(listFlights(db)).toHaveLength(1)
  })

  it('reuses an existing aircraft by registration rather than creating a duplicate', async () => {
    const filePath = join(dir, 'logbook.csv')
    writeFileSync(
      filePath,
      `${HEADER}\n${stkpRow()}\n${stkpRow({ FlightNo: 'BA200', 'DepTime (HHMM)': '1600', 'ArrTime (HHMM)': '1715' })}\n`,
      'utf-8'
    )
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

    const summary = await importLogbookCsv(db, FAKE_WINDOW)

    expect(summary?.aircraftCreated).toBe(1)
    expect(summary?.imported).toBe(2)
    expect(listAircraft(db)).toHaveLength(1)
  })

  it('skips a row that fails to parse', async () => {
    const filePath = join(dir, 'logbook.csv')
    writeFileSync(filePath, `${HEADER}\n${stkpRow({ DepartureICAO: '' })}\n`, 'utf-8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

    const summary = await importLogbookCsv(db, FAKE_WINDOW)

    expect(summary?.imported).toBe(0)
    expect(summary?.skipped).toHaveLength(1)
  })

  it('skips a row that duplicates one already in the logbook', async () => {
    const filePath = join(dir, 'logbook.csv')
    writeFileSync(filePath, `${HEADER}\n${stkpRow()}\n${stkpRow()}\n`, 'utf-8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

    const summary = await importLogbookCsv(db, FAKE_WINDOW)

    expect(summary?.imported).toBe(1)
    expect(summary?.skipped).toEqual([{ label: 'G-ABCD EGLL-EGCC', reason: 'already imported' }])
  })

  it('detects a duplicate against a flight already in the database from a prior import', async () => {
    const filePath = join(dir, 'logbook.csv')
    writeFileSync(filePath, `${HEADER}\n${stkpRow()}\n`, 'utf-8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    await importLogbookCsv(db, FAKE_WINDOW)

    const secondSummary = await importLogbookCsv(db, FAKE_WINDOW)

    expect(secondSummary?.imported).toBe(0)
    expect(secondSummary?.aircraftCreated).toBe(0)
    expect(secondSummary?.skipped).toEqual([{ label: 'G-ABCD EGLL-EGCC', reason: 'already imported' }])
  })
})
