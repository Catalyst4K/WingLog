import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { NavdataLeg, NavdataProcedureOption, ProcedureSelection } from '@shared/ipc'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import { VECTORS_TRANSITION } from '@shared/route'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { createFlight, getFlight, getLiveFlight, setSelectedProcedures } from '../db/flight-repo'
import { logger } from '../logging/logger'
import { ProcedureSelectionStore } from './ProcedureSelectionStore'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const proc = (identifier: string, transition: string | null = null): NavdataProcedureOption => ({
  identifier,
  transition
})

const leg = (fixIdent: string): NavdataLeg => ({
  type: 4,
  fixIdent,
  fixType: 'W',
  fixLatitude: 10,
  fixLongitude: 20,
  turnDirection: 0,
  courseDeg: 0,
  altitude1: 0,
  altitude2: 0,
  speedLimit: 0,
  routeDistanceM: 0
})

const OFP = JSON.stringify({
  general: { sid_ident: 'BPK7F' },
  navlog: {
    fix: [
      {
        ident: 'A',
        type: 'wpt',
        pos_lat: '1',
        pos_long: '1',
        altitude_feet: '3000',
        stage: 'CLB',
        via_airway: 'BPK7F'
      },
      {
        ident: 'B',
        type: 'wpt',
        pos_lat: '2',
        pos_long: '2',
        altitude_feet: '35000',
        stage: 'CRZ',
        via_airway: 'UL9'
      }
    ]
  }
})

const chosen = (over: Partial<ProcedureSelection> = {}): ProcedureSelection => ({
  ...emptyProcedureSelection(),
  ...over
})

/** A store on a real in-memory database, with a fake navdata cache the test fills and a flight it says is shown. */
function setup() {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
  const state = {
    shownId: undefined as number | undefined,
    approaches: {} as Record<string, NavdataProcedureOption[]>,
    starLegs: [] as NavdataLeg[],
    refreshed: new Set<(icao: string) => void>()
  }
  const announced: (ProcedureSelection | null)[] = []
  const makeStore = (database: WingLogDb = db): ProcedureSelectionStore => {
    const store = new ProcedureSelectionStore({
      shownFlight: () => (state.shownId === undefined ? undefined : getLiveFlight(database, state.shownId)),
      save: (id, selection) => setSelectedProcedures(database, id, selection),
      navdata: {
        listApproaches: (icao) => state.approaches[icao] ?? [],
        getProcedureWaypoints: (_icao: string, kind: string) => (kind === 'star' ? state.starLegs : []),
        onAirportRefreshed: (listener: (icao: string) => void) => {
          state.refreshed.add(listener)
          return () => state.refreshed.delete(listener)
        }
      }
    })
    store.on('changed', (selection) => announced.push(selection))
    return store
  }
  const flight = (over: Partial<Parameters<typeof createFlight>[1]> = {}) =>
    createFlight(db, { aircraftId, depIcao: 'ZGGG', arrIcao: 'ZJSY', ofpJson: OFP, ...over })
  return { db, state, announced, store: makeStore(), makeStore, flight }
}

beforeEach(() => {
  vi.mocked(logger.info).mockClear()
  vi.mocked(logger.warn).mockClear()
})

describe('ProcedureSelectionStore: which flight it holds', () => {
  it("loads a flight's saved choice when it becomes the flight shown, and announces it", () => {
    const { db, state, store, announced, flight } = setup()
    const f = flight()
    setSelectedProcedures(
      db,
      f.id,
      chosen({ sidIdent: 'BPK7F', starIdent: 'UPRS2C', approachIdent: 'ILS Z 08' })
    )
    expect(store.current()).toBeUndefined()
    state.shownId = f.id
    store.refresh()
    expect(store.current()).toMatchObject({
      sidIdent: 'BPK7F',
      starIdent: 'UPRS2C',
      approachIdent: 'ILS Z 08'
    })
    expect(announced).toEqual([store.current()])
  })

  it('announces nothing more for the same flight', () => {
    const { state, store, announced, flight } = setup()
    state.shownId = flight().id
    store.refresh()
    store.refresh()
    store.refresh()
    expect(announced).toHaveLength(1)
  })

  it("loads the next flight's own choice, not the finished flight's", () => {
    // After a flight completes the one planned next is shown; it must never be built from the finished flight's procedures.
    const { db, state, store, flight } = setup()
    const first = flight()
    setSelectedProcedures(db, first.id, chosen({ sidIdent: 'FIRST1A', approachIdent: 'ILS 08' }))
    state.shownId = first.id
    store.refresh()
    store.set(chosen({ sidIdent: 'CHANGED', approachIdent: 'ILS 08' }), 'phone')

    const next = flight({ depIcao: 'EGLL', arrIcao: 'EGCC' })
    setSelectedProcedures(db, next.id, chosen({ sidIdent: 'NEXT2B' }))
    state.shownId = next.id
    store.refresh()
    expect(store.current()).toMatchObject({ sidIdent: 'NEXT2B', approachIdent: null })
    expect(getFlight(db, first.id)?.selectedSidIdent).toBe('CHANGED')
  })

  it('announces none, and holds none, when no flight is shown any more', () => {
    const { state, store, announced, flight } = setup()
    state.shownId = flight().id
    store.refresh()
    state.shownId = undefined
    store.refresh()
    expect(store.current()).toBeUndefined()
    expect(announced.at(-1)).toBeNull()
    store.refresh()
    expect(announced).toHaveLength(2)
  })
})

describe('ProcedureSelectionStore: a choice set by a screen', () => {
  it('replaces the choice, saves it on the flight, announces it and logs where it came from', () => {
    const { db, state, store, announced, flight } = setup()
    const f = flight()
    state.shownId = f.id
    store.refresh()
    store.set(chosen({ sidIdent: 'BPK7F', starIdent: 'UPRS2C' }), 'phone')
    expect(store.current()).toMatchObject({ sidIdent: 'BPK7F', starIdent: 'UPRS2C' })
    expect(announced.at(-1)).toMatchObject({ sidIdent: 'BPK7F', starIdent: 'UPRS2C' })
    expect(getFlight(db, f.id)).toMatchObject({ selectedSidIdent: 'BPK7F', selectedStarIdent: 'UPRS2C' })
    expect(
      vi
        .mocked(logger.info)
        .mock.calls.some((c) => /\[selection\] flight \d+: SID BPK7F.*\(from the phone\)/.test(String(c[0])))
    ).toBe(true)
  })

  it('changes nothing for a choice equal to the one held: no announcement, no save', () => {
    const { db, state, store, announced, flight } = setup()
    const f = flight()
    state.shownId = f.id
    store.refresh()
    store.set(chosen({ sidIdent: 'X' }), 'window')
    const count = announced.length
    const saved = getFlight(db, f.id)
    store.set(chosen({ sidIdent: 'X' }), 'phone')
    expect(announced).toHaveLength(count)
    expect(getFlight(db, f.id)).toEqual(saved)
  })

  it('takes the last choice it was sent: two screens in a row converge on the second', () => {
    const { state, store, announced, flight } = setup()
    state.shownId = flight().id
    store.refresh()
    store.set(chosen({ sidIdent: 'FROM_WINDOW' }), 'window')
    store.set(chosen({ sidIdent: 'FROM_PHONE' }), 'phone')
    expect(store.current()?.sidIdent).toBe('FROM_PHONE')
    expect(announced.at(-1)?.sidIdent).toBe('FROM_PHONE')
  })

  it('saves every change, so a store started again on the same database (a restart) has the choice', () => {
    const { db, state, store, makeStore, flight } = setup()
    const f = flight()
    state.shownId = f.id
    store.refresh()
    store.set(chosen({ sidIdent: 'BPK7F' }), 'window')
    store.set(chosen({ sidIdent: 'BPK7F', starIdent: 'UPRS2C', approachIdent: 'ILS Z 08' }), 'phone')

    const afterRestart = makeStore(db)
    afterRestart.refresh()
    expect(afterRestart.current()).toMatchObject({
      sidIdent: 'BPK7F',
      starIdent: 'UPRS2C',
      approachIdent: 'ILS Z 08'
    })
  })

  it('ignores a choice when no flight is shown', () => {
    const { store, announced } = setup()
    store.set(chosen({ sidIdent: 'X' }), 'phone')
    expect(store.current()).toBeUndefined()
    expect(announced).toEqual([])
  })

  it('logs a failure to save and goes on, rather than throwing into the screen that asked', () => {
    const { db, state, flight } = setup()
    state.shownId = flight().id
    const store = new ProcedureSelectionStore({
      shownFlight: () => getLiveFlight(db, state.shownId!),
      save: () => {
        throw new Error('database is locked')
      },
      navdata: {
        listApproaches: () => [],
        getProcedureWaypoints: () => [],
        onAirportRefreshed: () => () => undefined
      }
    })
    store.refresh()
    expect(() => store.set(chosen({ sidIdent: 'X' }), 'phone')).not.toThrow()
    expect(
      vi.mocked(logger.warn).mock.calls.some((c) => String(c[0]).includes('[selection] set failed'))
    ).toBe(true)
  })
})

describe('ProcedureSelectionStore: the suggested approach', () => {
  const ZJSY = [proc('ILS X 08', 'SY400'), proc('ILS Z 08', 'SY498')]

  it("suggests one when the arrival's approaches arrive after the flight started (the 2026-10-22 case), saves and announces it", () => {
    const { db, state, store, announced, flight } = setup()
    const f = flight()
    state.shownId = f.id
    store.refresh()
    expect(store.current()?.approachIdent).toBeNull()

    // The sim comes up and the airport's navdata is fetched: nothing on any screen has to be open for the approach to appear.
    state.approaches.ZJSY = ZJSY
    state.refreshed.forEach((listener) => listener('ZJSY'))
    expect(store.current()?.approachIdent).toBe('ILS X 08')
    expect(announced.at(-1)?.approachIdent).toBe('ILS X 08')
    expect(getFlight(db, f.id)?.selectedApproachIdent).toBe('ILS X 08')
  })

  it('suggests straight away when the approaches are already cached', () => {
    const { state, store, flight } = setup()
    state.approaches.ZJSY = ZJSY
    state.shownId = flight().id
    store.refresh()
    expect(store.current()?.approachIdent).toBe('ILS X 08')
  })

  it('suggests the approach the STAR leads into, with the transition that joins them', () => {
    const { db, state, store, flight } = setup()
    const f = flight()
    setSelectedProcedures(db, f.id, chosen({ starIdent: 'UPRS2C' }))
    state.starLegs = [leg('SY300'), leg('SY498')]
    state.approaches.ZJSY = ZJSY
    state.shownId = f.id
    store.refresh()
    expect(store.current()).toMatchObject({ approachIdent: 'ILS Z 08', approachTransition: 'SY498' })
  })

  it("swaps its own suggestion for the connecting approach when the STAR is chosen afterwards, but never the pilot's", () => {
    const { state, store, flight } = setup()
    state.approaches.ZJSY = ZJSY
    state.shownId = flight().id
    store.refresh()
    expect(store.current()?.approachIdent).toBe('ILS X 08')
    state.starLegs = [leg('SY498')]
    store.set(chosen({ ...store.current(), starIdent: 'UPRS2C' }), 'phone')
    expect(store.current()).toMatchObject({ approachIdent: 'ILS Z 08', approachTransition: 'SY498' })

    // The pilot picks the other one on purpose: it stays whatever the STAR ends at.
    store.set(
      chosen({ ...store.current(), approachIdent: 'ILS X 08', approachTransition: VECTORS_TRANSITION }),
      'phone'
    )
    state.starLegs = [leg('SY498')]
    store.set(chosen({ ...store.current(), starTransition: 'T1' }), 'phone')
    expect(store.current()).toMatchObject({
      approachIdent: 'ILS X 08',
      approachTransition: VECTORS_TRANSITION
    })
  })

  it('does not suggest an approach again after the pilot cleared it, on any screen', () => {
    const { state, store, flight } = setup()
    state.approaches.ZJSY = ZJSY
    state.shownId = flight().id
    store.refresh()
    expect(store.current()?.approachIdent).toBeTruthy()
    store.set(chosen({ ...store.current(), approachIdent: null, approachTransition: null }), 'phone')
    expect(store.current()?.approachIdent).toBeNull()
    state.refreshed.forEach((listener) => listener('ZJSY'))
    store.refresh()
    expect(store.current()?.approachIdent).toBeNull()
  })

  it("treats a switch to the alternate as a new airport, not a cleared approach, and suggests the alternate's", () => {
    const { state, store, flight } = setup()
    state.approaches.ZJSY = ZJSY
    state.approaches.ZGSZ = [proc('ILS 33')]
    state.shownId = flight().id
    store.refresh()
    expect(store.current()?.approachIdent).toBe('ILS X 08')
    store.set(
      chosen({ ...store.current(), arrivalIcao: 'ZGSZ', approachIdent: null, approachTransition: null }),
      'phone'
    )
    expect(store.current()).toMatchObject({ arrivalIcao: 'ZGSZ', approachIdent: 'ILS 33' })
  })

  it('leaves an approach alone that is already chosen, and a flight with no arrival airport', () => {
    const { db, state, store, flight } = setup()
    state.approaches.ZJSY = ZJSY
    const chosenAlready = flight()
    setSelectedProcedures(
      db,
      chosenAlready.id,
      chosen({ approachIdent: 'ILS Z 08', approachTransition: 'OWN' })
    )
    state.shownId = chosenAlready.id
    store.refresh()
    expect(store.current()).toMatchObject({ approachIdent: 'ILS Z 08', approachTransition: 'OWN' })

    const free = flight({ arrIcao: 'ZZZZ', ofpJson: null })
    state.shownId = free.id
    store.refresh()
    expect(store.current()?.approachIdent).toBeNull()
  })

  it("ignores another airport's refresh", () => {
    const { state, store, flight } = setup()
    state.shownId = flight().id
    store.refresh()
    state.approaches.ZJSY = ZJSY
    state.refreshed.forEach((listener) => listener('EGLL'))
    expect(store.current()?.approachIdent).toBeNull()
  })
})
