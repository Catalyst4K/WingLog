import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { ProcedureSelection } from '@shared/ipc'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { createFlight } from '../db/flight-repo'
import { shownFlight } from '../lan/lan-flight'
import { twinSyncDeviceQueries, type PullPage } from '../lan/twin-sync'
import { ProcedureSelectionStore } from './ProcedureSelectionStore'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("a twin's procedure choice reaching the sim PC", () => {
  it('is taken up by the PC from the pushed row alone, with no window open: the store, the push and the refresh are all in the main process', async () => {
    // 2026-11-21: a Mac accepted BeyondATC's 07R and PECA3A. The PC's window was in the tray; nothing here involves one.
    const { db } = createDb(':memory:')
    migrate(db, { migrationsFolder: 'drizzle' })
    const dir = mkdtempSync(join(tmpdir(), 'winglog-twin-choice-'))
    dirs.push(dir)
    const aircraftId = createAircraft(db, { registration: 'B-HLA', icaoType: 'A320' }).id
    createFlight(db, {
      aircraftId,
      depIcao: 'VHHH',
      arrIcao: 'ZJSY',
      selectedDepartureRunway: '07C',
      selectedSidIdent: 'PECA1Y'
    })
    const store = new ProcedureSelectionStore({
      shownFlight: () => shownFlight(db, undefined),
      save: () => undefined,
      navdata: {
        listApproaches: () => [],
        getProcedureWaypoints: () => [],
        onAirportRefreshed: () => () => undefined
      }
    })
    const announced: (ProcedureSelection | null)[] = []
    store.on('changed', (selection) => announced.push(selection))
    store.refresh()
    expect(store.current()).toMatchObject({ departureRunway: '07C', sidIdent: 'PECA1Y' })

    // The host's twin queries wired as index.ts wires them: the refresh runs when pushed rows were applied.
    const device = twinSyncDeviceQueries(db, join(dir, 'winglog.db'), () => store.refresh())
    const page = device['sync.pull'](7, 'flight', null, undefined) as PullPage
    expect(page.rows).toHaveLength(1)
    const row = page.rows[0]
    const pushed = {
      ...JSON.parse(row.data),
      selectedDepartureRunway: '07R',
      selectedSidIdent: 'PECA3A'
    }
    const result = (await device['sync.push'](
      7,
      'flight',
      [{ ...row, updatedAt: new Date(Date.now() + 1000).toISOString(), data: JSON.stringify(pushed) }],
      undefined
    )) as { upserted: string[] }

    expect(result.upserted).toHaveLength(1)
    expect(store.current()).toMatchObject({ departureRunway: '07R', sidIdent: 'PECA3A' })
    expect(announced.at(-1)).toMatchObject({ departureRunway: '07R', sidIdent: 'PECA3A' })
  })
})
