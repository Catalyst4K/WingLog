import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BrowserWindow } from 'electron'
import { createDb, type WingLogDb } from './client'
import { createAircraft, listAircraft } from './aircraft-repo'
import { createHistoricalFlight, listFlights } from './flight-repo'
import { createLanding } from './landing-repo'
import {
  buildLogbookExport,
  exportLogbook,
  importFlightRows,
  importLogbookCsv,
  importLogbookJson
} from './logbook-import'

const { showOpenDialog, showSaveDialog } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn()
}))

vi.mock('electron', () => ({ dialog: { showOpenDialog, showSaveDialog } }))

const FAKE_WINDOW = {} as BrowserWindow

function freshDb(): WingLogDb {
  const created = createDb(':memory:')
  migrate(created.db, { migrationsFolder: 'drizzle' })
  return created.db
}

function seed(db: WingLogDb): void {
  const a320 = createAircraft(db, { registration: 'G-EUUU', icaoType: 'A320' })
  const cessna = createAircraft(db, { registration: 'N172SP', icaoType: 'C172' })
  const first = createHistoricalFlight(db, {
    aircraftId: a320.id,
    depIcao: 'EGLL',
    arrIcao: 'EGCC',
    flightNumber: 'BA1388',
    actualOutUtc: '2026-08-21T12:00:00.000Z',
    actualInUtc: '2026-08-21T13:15:00.000Z',
    airMinutes: 62,
    fuelOutKg: 5200,
    fuelInKg: 3900,
    fuelBurnKg: 1300
  })
  createLanding(db, {
    flightId: first.id,
    seq: 1,
    icao: 'EGCC',
    touchdownTsUtc: '2026-08-21T13:05:00.000Z',
    verticalSpeedMs: -1.2,
    gForce: 1.15,
    pitchDeg: 3,
    bankDeg: 0,
    headingTrueDeg: 230,
    indicatedAirspeedMs: 70,
    groundSpeedMs: 65,
    windSpeedMs: 4,
    windDirectionDeg: 200,
    headwindMs: 3,
    crosswindMs: 2,
    crabDeg: 2,
    touchdownSource: 'simvar'
  } as Parameters<typeof createLanding>[1])
  createHistoricalFlight(db, {
    aircraftId: cessna.id,
    depIcao: 'EGKB',
    arrIcao: 'EGMD',
    flightNumber: null,
    actualOutUtc: '2026-08-22T09:00:00.000Z',
    actualInUtc: '2026-08-22T09:50:00.000Z'
  })
}

/** What a round trip must preserve — the flight's own identity and metrics, not row ids. */
function summarise(db: WingLogDb): unknown[] {
  const reg = new Map(listAircraft(db).map((a) => [a.id, `${a.registration}/${a.icaoType}`]))
  return listFlights(db)
    .map((f) => ({
      aircraft: reg.get(f.aircraftId as number),
      flightNumber: f.flightNumber,
      dep: f.depIcao,
      arr: f.arrIcao,
      out: f.actualOutUtc,
      in: f.actualInUtc,
      block: f.blockMinutes,
      air: f.airMinutes,
      fuel: [f.fuelOutKg, f.fuelInKg, f.fuelBurnKg]
    }))
    .sort((a, b) => String(a.out).localeCompare(String(b.out)))
}

describe('logbook export → import round trip', () => {
  let db: WingLogDb
  let dir: string

  beforeEach(() => {
    db = freshDb()
    seed(db)
    dir = mkdtempSync(join(tmpdir(), 'winglog-logbook-roundtrip-'))
    showOpenDialog.mockReset()
    showSaveDialog.mockReset()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it.each(['csv', 'json'] as const)('exports %s and re-imports it into an empty database with identical flights', async (format) => {
    const filePath = join(dir, `logbook.${format}`)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    expect(await exportLogbook(db, FAKE_WINDOW, format)).toBe(true)

    const target = freshDb()
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    const summary = await (format === 'csv' ? importLogbookCsv(target, FAKE_WINDOW) : importLogbookJson(target, FAKE_WINDOW))

    expect(summary).toEqual({ imported: 2, aircraftCreated: 2, skipped: [] })
    expect(summarise(target)).toEqual(summarise(db))
  })

  it('does not double the logbook when the same export is imported twice', async () => {
    const filePath = join(dir, 'logbook.json')
    writeFileSync(filePath, buildLogbookExport(db, 'json'), 'utf-8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

    const summary = await importLogbookJson(db, FAKE_WINDOW)

    expect(summary?.imported).toBe(0)
    expect(summary?.skipped.map((s) => s.reason)).toEqual(['already imported', 'already imported'])
    expect(listFlights(db)).toHaveLength(2)
  })

  it('includes the landing columns in the export, but never the OFP or track data', () => {
    const csv = buildLogbookExport(db, 'csv')
    expect(csv).toContain('touchdown_fpm')
    expect(csv).toContain('G-EUUU,A320,BA1388,EGLL,EGCC')
    expect(csv).toContain(',-236,1.15,3.9,')
    expect(csv).not.toMatch(/ofp|track/i)
  })

  it('returns false without writing when the save dialog is cancelled, and null when an open dialog is', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    expect(await exportLogbook(db, FAKE_WINDOW, 'csv')).toBe(false)
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await importLogbookJson(db, FAKE_WINDOW)).toBeNull()
    expect(await importLogbookCsv(db, FAKE_WINDOW)).toBeNull()
  })

  it('names the default file after the chosen format', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    await exportLogbook(db, FAKE_WINDOW, 'json')
    expect(showSaveDialog).toHaveBeenCalledWith(
      FAKE_WINDOW,
      expect.objectContaining({ defaultPath: 'winglog-logbook.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    )
  })

  it('refuses an implausibly large import file before reading it', async () => {
    const filePath = join(dir, 'huge.json')
    writeFileSync(filePath, Buffer.alloc(26 * 1024 * 1024, 0x20))
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    await expect(importLogbookJson(freshDb(), FAKE_WINDOW)).rejects.toThrow('too large')
  })

  it('reports a malformed row in the summary instead of failing the whole import', async () => {
    const filePath = join(dir, 'mixed.json')
    writeFileSync(
      filePath,
      JSON.stringify([
        { registration: 'G-GOOD', icaoType: 'A320', depIcao: 'EGLL', arrIcao: 'EGCC', outUtc: '2026-09-01T10:00:00Z', inUtc: '2026-09-01T11:00:00Z' },
        { registration: 'G-BAD', icaoType: 'A320', depIcao: 'EGLL' }
      ]),
      'utf-8'
    )
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

    const summary = await importLogbookJson(freshDb(), FAKE_WINDOW)

    expect(summary?.imported).toBe(1)
    expect(summary?.skipped).toEqual([{ label: 'G-BAD', reason: 'missing or malformed required field' }])
  })

  it('still imports a SimToolkitPro CSV through the same button (header sniffing)', async () => {
    const filePath = join(dir, 'stkp.csv')
    writeFileSync(
      filePath,
      'DepartureICAO,ArrivalICAO,AircraftReg,AirframeICAO,Callsign,FlightNo,Network,DepDate (DD/MM/YY),DepTime (HHMM),ArrDate (DD/MM/YY),ArrTime (HHMM)\n' +
        'EGLL,EGCC,G-ABCD,A320,,BA100,,21/08/2026,1200,21/08/2026,1315\n',
      'utf-8'
    )
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    expect((await importLogbookCsv(freshDb(), FAKE_WINDOW))?.imported).toBe(1)
  })

  it('importFlightRows skips error rows with their label and reason', () => {
    const summary = importFlightRows(freshDb(), [{ label: 'row 3', error: 'nope' }])
    expect(summary).toEqual({ imported: 0, aircraftCreated: 0, skipped: [{ label: 'row 3', reason: 'nope' }] })
  })

  it('writes the file exactly as buildLogbookExport returns it', async () => {
    const filePath = join(dir, 'out.csv')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    await exportLogbook(db, FAKE_WINDOW, 'csv')
    expect(readFileSync(filePath, 'utf-8')).toBe(buildLogbookExport(db, 'csv'))
  })
})
