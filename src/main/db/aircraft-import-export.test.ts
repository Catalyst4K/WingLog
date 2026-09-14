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
