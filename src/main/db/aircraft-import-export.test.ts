import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BrowserWindow } from 'electron'
import { createDb, type WingLogDb } from './client'
import { createAircraft, listAircraft } from './aircraft-repo'
import { exportAircraft, importAircraft } from './aircraft-import-export'

const { showSaveDialog, showOpenDialog } = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showSaveDialog, showOpenDialog }
}))

const FAKE_WINDOW = {} as BrowserWindow

describe('aircraft import/export', () => {
  let db: WingLogDb
  let dir: string

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    dir = mkdtempSync(join(tmpdir(), 'winglog-aircraft-io-'))
    showSaveDialog.mockReset()
    showOpenDialog.mockReset()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('exportAircraft', () => {
    it('returns false when the save dialog is cancelled', async () => {
      showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
      const result = await exportAircraft(db, FAKE_WINDOW)
      expect(result).toBe(false)
    })

    it('writes the fleet as JSON, omitting id/createdAt', async () => {
      createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320', operator: 'Test Air' })
      const filePath = join(dir, 'fleet.json')
      showSaveDialog.mockResolvedValue({ canceled: false, filePath })

      const result = await exportAircraft(db, FAKE_WINDOW)

      expect(result).toBe(true)
      const written = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(written).toEqual([
        {
          registration: 'G-ABCD',
          icaoType: 'A320',
          operator: 'Test Air',
          operatorIata: null,
          operatorIcao: null,
          simbriefAirframeId: null,
          simbriefType: null,
          currentIcao: null
        }
      ])
      expect(written[0]).not.toHaveProperty('id')
      expect(written[0]).not.toHaveProperty('createdAt')
    })
  })

  describe('importAircraft', () => {
    it('returns null when the open dialog is cancelled', async () => {
      showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
      const result = await importAircraft(db, FAKE_WINDOW)
      expect(result).toBeNull()
    })

    it('imports a single-object file (not wrapped in an array)', async () => {
      const filePath = join(dir, 'one.json')
      writeFileSync(filePath, JSON.stringify({ registration: 'G-ABCD', icaoType: 'A320' }), 'utf-8')
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

      const summary = await importAircraft(db, FAKE_WINDOW)

      expect(summary).toEqual({ imported: 1, skipped: [] })
      expect(listAircraft(db)).toHaveLength(1)
    })

    it('imports an array of aircraft, skipping invalid and duplicate entries', async () => {
      createAircraft(db, { registration: 'G-EXIST', icaoType: 'B738' })
      const filePath = join(dir, 'fleet.json')
      writeFileSync(
        filePath,
        JSON.stringify([
          { registration: 'G-NEW1', icaoType: 'A320' },
          { registration: 'G-EXIST', icaoType: 'B738' },
          { registration: '', icaoType: '' },
          'not-an-object'
        ]),
        'utf-8'
      )
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

      const summary = await importAircraft(db, FAKE_WINDOW)

      expect(summary?.imported).toBe(1)
      expect(summary?.skipped).toHaveLength(3)
      expect(summary?.skipped.find((s) => s.reason === 'registration already exists')?.registration).toBe('G-EXIST')
      expect(listAircraft(db).map((a) => a.registration)).toEqual(['G-EXIST', 'G-NEW1'])
    })

    it('labels an unparseable record without a registration as "(unknown)"', async () => {
      const filePath = join(dir, 'bad.json')
      writeFileSync(filePath, JSON.stringify([42]), 'utf-8')
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

      const summary = await importAircraft(db, FAKE_WINDOW)

      expect(summary?.imported).toBe(0)
      expect(summary?.skipped).toEqual([{ registration: '(unknown)', reason: expect.any(String) }])
    })
  })
})

describe('aircraft CSV import/export (docs/plans/data-export-import.md)', () => {
  let db: WingLogDb
  let dir: string

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    dir = mkdtempSync(join(tmpdir(), 'winglog-aircraft-csv-'))
    showSaveDialog.mockReset()
    showOpenDialog.mockReset()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('exports the fleet as CSV with a .csv default name and filter', async () => {
    createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320', operator: 'Test, Air' })
    const filePath = join(dir, 'fleet.csv')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath })

    expect(await exportAircraft(db, FAKE_WINDOW, 'csv')).toBe(true)

    expect(showSaveDialog).toHaveBeenCalledWith(
      FAKE_WINDOW,
      expect.objectContaining({ defaultPath: 'winglog-fleet.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })
    )
    expect(readFileSync(filePath, 'utf-8')).toBe(
      'registration,icaoType,operator,operatorIata,operatorIcao,simbriefAirframeId,simbriefType,currentIcao\r\n' +
        'G-ABCD,A320,"Test, Air",,,,,\r\n'
    )
  })

  it('round-trips a fleet through CSV, skipping existing registrations and invalid rows with a reason', async () => {
    createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320', operator: 'Test, Air', currentIcao: 'EGLL' })
    const filePath = join(dir, 'fleet.csv')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    await exportAircraft(db, FAKE_WINDOW, 'csv')
    writeFileSync(filePath, readFileSync(filePath, 'utf-8') + ',B738,,,,,,\r\nG-NEWW,B738,Other Air,,,,,\r\n', 'utf-8')

    const target = createDb(':memory:')
    migrate(target.db, { migrationsFolder: 'drizzle' })
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    const first = await importAircraft(target.db, FAKE_WINDOW, 'csv')
    expect(first?.imported).toBe(2)
    expect(first?.skipped).toEqual([{ registration: '(unknown)', reason: '"registration" is required' }])
    expect(listAircraft(target.db).map((a) => [a.registration, a.operator, a.currentIcao])).toEqual([
      ['G-ABCD', 'Test, Air', 'EGLL'],
      ['G-NEWW', 'Other Air', null]
    ])

    const second = await importAircraft(target.db, FAKE_WINDOW, 'csv')
    expect(second?.imported).toBe(0)
  })

  it('imports JSON when no format is given (the original behaviour)', async () => {
    const filePath = join(dir, 'fleet.json')
    writeFileSync(filePath, '[{"registration":"G-JSON","icaoType":"A320"}]', 'utf-8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    expect((await importAircraft(db, FAKE_WINDOW))?.imported).toBe(1)
  })
})
