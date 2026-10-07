import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { completeFlight, createFlight, startFlight } from '../db/flight-repo'
import { setGsxSettings } from '../db/settings-repo'
import { fakeIpc } from './fake-ipc'
import { registerGsxHandlers } from './gsx-handlers'

const showOpenDialog = vi.fn()
const openPath = vi.fn()
vi.mock('electron', () => ({
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) },
  shell: { openPath: (path: string) => openPath(path) }
}))

/** Writes a GSX receipt pair (JSON and HTML) in GSX's own layout and names. */
function writeReceipt(dir: string, filename: string, total: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), JSON.stringify({ total }), 'utf-8')
  writeFileSync(join(dir, filename.replace(/\.json$/, '.html')), '<html></html>', 'utf-8')
  return join(dir, filename)
}

type Rescan = {
  invoices: { totalUsd: number | null }[]
  notailCandidates: { jsonPath: string; icao: string }[]
}

describe('GSX invoice IPC handlers', () => {
  let db: WingLogDb
  let root: string
  let flightId: number
  let invoke: ReturnType<typeof fakeIpc>['invoke']
  const sync = vi.fn()
  const window = {} as BrowserWindow

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'winglog-gsx-ipc-'))
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    vi.clearAllMocks()
    // A flight G-ABCD flew EGLL to EGCC, 12:00 to 13:00 UTC.
    const aircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    flightId = createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' }).id
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
    startFlight(db, flightId, 6000)
    vi.setSystemTime(new Date('2026-09-06T13:00:00Z'))
    completeFlight(db, flightId, 3000)
    vi.useRealTimers()
    const ipc = fakeIpc()
    invoke = ipc.invoke
    registerGsxHandlers(ipc.ipcMain, { db, window, scheduleBackgroundSync: sync })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns the chosen folder, or null when the dialog is cancelled', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] })
    expect(await invoke(IpcChannels.gsxBrowseFolder)).toBe(root)
    expect(showOpenDialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ properties: ['openDirectory'] })
    )
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await invoke(IpcChannels.gsxBrowseFolder)).toBeNull()
  })

  it("doesn't scan while GSX invoices are off or have no folder", async () => {
    writeReceipt(join(root, 'Fuel'), '20260906T121500Z_EGLL_G-ABCD.json', '£40.00 ~$ 50.00')
    expect(await invoke(IpcChannels.gsxRescanFlight, flightId)).toEqual({
      invoices: [],
      notailCandidates: []
    })
    setGsxSettings(db, { enabled: true, folderPath: null, displayCurrency: 'USD' })
    expect(await invoke(IpcChannels.gsxRescanFlight, flightId)).toEqual({
      invoices: [],
      notailCandidates: []
    })
    expect(sync).not.toHaveBeenCalled()
  })

  it("attaches the flight's receipts and offers the untagged ones, syncing only when something matched", async () => {
    setGsxSettings(db, { enabled: true, folderPath: root, displayCurrency: 'USD' })
    writeReceipt(join(root, 'Fuel'), '20260906T121500Z_EGLL_G-ABCD.json', '£40.00 ~$ 50.00')
    const notail = writeReceipt(join(root, 'Catering'), '20260906T122000Z_EGLL_NOTAIL.json', '£8.00 ~$ 10.00')
    const first = (await invoke(IpcChannels.gsxRescanFlight, flightId)) as Rescan
    expect(first.invoices.map((i) => i.totalUsd)).toEqual([50])
    expect(first.notailCandidates).toEqual([expect.objectContaining({ jsonPath: notail, icao: 'EGLL' })])
    expect(sync).toHaveBeenCalledTimes(1)

    expect(await invoke(IpcChannels.gsxRescanFlight, 999)).toEqual({ invoices: [], notailCandidates: [] })
  })

  it('attaches an untagged receipt the pilot picks, ignoring anything that is not one', async () => {
    const notail = writeReceipt(join(root, 'Catering'), '20260906T122000Z_EGLL_NOTAIL.json', '£8.00 ~$ 10.00')
    expect(await invoke(IpcChannels.gsxAttachNotailReceipt, flightId, join(root, 'notes.json'))).toEqual([])
    expect(
      await invoke(IpcChannels.gsxAttachNotailReceipt, flightId, join(root, 'Fuel', 'missing.json'))
    ).toEqual([])
    expect(sync).not.toHaveBeenCalled()
    const invoices = (await invoke(IpcChannels.gsxAttachNotailReceipt, flightId, notail)) as {
      totalUsd: number
    }[]
    expect(invoices.map((i) => i.totalUsd)).toEqual([10])
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('opens a receipt', () => {
    invoke(IpcChannels.gsxOpenReceipt, join(root, 'Fuel', 'receipt.html'))
    expect(openPath).toHaveBeenCalledWith(join(root, 'Fuel', 'receipt.html'))
  })
})
