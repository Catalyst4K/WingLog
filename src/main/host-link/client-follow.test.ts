import { describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { LanFlightSnapshot, ProcedureSelection } from '@shared/ipc'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { createFlight, getLiveFlight, setSelectedProcedures } from '../db/flight-repo'
import { shownFlight } from '../lan/lan-flight'
import { ProcedureSelectionStore } from '../procedures/ProcedureSelectionStore'
import { followHostFlight, onSyncLanded, showHeldRoute } from './client-follow'
import { FlightMirror, mapFlightTopic } from './flight-mirror'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const SNAPSHOT = { flight: { flightId: 7, uuid: 'u', tracking: true } } as unknown as LanFlightSnapshot

describe('followHostFlight', () => {
  it('keeps the mirror and has the procedure store look again, whether the sim PC shows a flight or none', () => {
    const mirror = new FlightMirror(() => 3)
    const selection = { refresh: vi.fn() }
    const follow = followHostFlight(mirror, selection)
    follow(SNAPSHOT, () => [])
    expect(mirror.hostTracking()).toBe(true)
    expect(selection.refresh).toHaveBeenCalledTimes(1)
    follow(null, () => [])
    expect(mirror.hostTracking()).toBe(false)
    expect(selection.refresh).toHaveBeenCalledTimes(2)
  })

  it('hides the store while the sim PC flies and shows it again after', () => {
    const { db } = createDb(':memory:')
    migrate(db, { migrationsFolder: 'drizzle' })
    const aircraftId = createAircraft(db, { registration: 'B-HLA', icaoType: 'A320' }).id
    createFlight(db, { aircraftId, depIcao: 'VHHH', arrIcao: 'ZJSY', selectedSidIdent: 'PECA1Y' })
    const mirror = new FlightMirror(() => 3)
    const store = new ProcedureSelectionStore({
      shownFlight: () => (mirror.hostTracking() ? undefined : shownFlight(db, undefined)),
      save: () => undefined,
      navdata: {
        listApproaches: () => [],
        getProcedureWaypoints: () => [],
        onAirportRefreshed: () => () => undefined
      }
    })
    store.refresh()
    expect(store.current()).toMatchObject({ sidIdent: 'PECA1Y' })
    const follow = followHostFlight(mirror, store)
    follow(SNAPSHOT, () => [])
    expect(store.current()).toBeUndefined()
    follow(null, () => [])
    expect(store.current()).toMatchObject({ sidIdent: 'PECA1Y' })
  })
})

describe('onSyncLanded', () => {
  function fakeSync() {
    const listeners: (() => void)[] = []
    let status = { state: 'idle', lastSyncedAt: null as string | null }
    return {
      sync: {
        onChange: (listener: () => void) => void listeners.push(listener),
        status: () => status
      } as never,
      set(state: string, lastSyncedAt: string | null) {
        status = { state, lastSyncedAt }
        listeners.forEach((listener) => listener())
      }
    }
  }

  it('calls once for each sync that ended well, not while one runs, fails, or has already been seen', () => {
    const { sync, set } = fakeSync()
    const landed = vi.fn()
    onSyncLanded(sync, landed)
    set('syncing', null)
    set('error', null)
    expect(landed).not.toHaveBeenCalled()
    set('idle', '2026-11-21T11:00:00Z')
    set('idle', '2026-11-21T11:00:00Z')
    expect(landed).toHaveBeenCalledTimes(1)
    set('idle', '2026-11-21T11:05:00Z')
    expect(landed).toHaveBeenCalledTimes(2)
  })

  it("lets the store take up a choice a sync wrote on the row, so a choice that undoes the store's stale copy is saved (an approach set to None here after the sim PC suggested one)", () => {
    const { db } = createDb(':memory:')
    migrate(db, { migrationsFolder: 'drizzle' })
    const aircraftId = createAircraft(db, { registration: 'B-HLA', icaoType: 'A320' }).id
    const planned = createFlight(db, { aircraftId, depIcao: 'VHHH', arrIcao: 'ZJSY' })
    const store = new ProcedureSelectionStore({
      shownFlight: () => shownFlight(db, undefined),
      save: (id, selection) => setSelectedProcedures(db, id, selection),
      navdata: {
        listApproaches: () => [],
        getProcedureWaypoints: () => [],
        onAirportRefreshed: () => () => undefined
      }
    })
    store.refresh()
    expect(store.current()?.approachIdent).toBeNull()
    const { sync, set } = fakeSync()
    onSyncLanded(sync, () => store.refresh())

    // The sim PC suggested an approach and a sync wrote it on this computer's row.
    const withApproach: ProcedureSelection = { ...emptyProcedureSelection(), approachIdent: 'ILS 07L' }
    setSelectedProcedures(db, planned.id, withApproach)
    set('idle', '2026-11-21T11:00:00Z')
    expect(store.current()?.approachIdent).toBe('ILS 07L')

    // The pilot clears it here: it is a change, so it is saved.
    store.set({ ...withApproach, approachIdent: null }, 'window')
    expect(getLiveFlight(db, planned.id)?.selectedApproachIdent).toBeNull()
  })
})

describe('showHeldRoute', () => {
  const route = {
    flightId: 445,
    flightUuid: 'u',
    revision: 1,
    selection: emptyProcedureSelection(),
    waypoints: []
  }

  it('puts the sim PC’s route in the hub once its flight has synced, and not before', () => {
    let localId: number | undefined
    const mirror = new FlightMirror(() => localId)
    const hub = { publish: vi.fn() }
    mapFlightTopic(mirror, 'plannedRoute', route)
    showHeldRoute(mirror, hub)
    expect(hub.publish).not.toHaveBeenCalled()
    localId = 3
    showHeldRoute(mirror, hub)
    expect(hub.publish).toHaveBeenCalledWith('plannedRoute', expect.objectContaining({ flightId: 3 }))
    showHeldRoute(mirror, hub)
    expect(hub.publish).toHaveBeenCalledTimes(1)
  })
})
