import { describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { NavdataLeg, ProcedureSelection } from '@shared/ipc'
import type { PlannedRoute } from '@shared/live'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { createFlight, setSelectedProcedures, startFlight } from '../db/flight-repo'
import { PlannedRoutePublisher } from './PlannedRoutePublisher'

const OFP_JSON = JSON.stringify({
  general: { sid_ident: 'BPK7F' },
  navlog: {
    fix: [
      {
        ident: 'SIDFIX',
        type: 'wpt',
        pos_lat: '1',
        pos_long: '1',
        altitude_feet: '3000',
        stage: 'CLB',
        via_airway: 'BPK7F'
      },
      {
        ident: 'CRUISE',
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

function leg(fixIdent: string): NavdataLeg {
  return {
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
  }
}

function build(options: { legsOf?: (identifier: string) => NavdataLeg[] } = {}) {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
  const sent: (PlannedRoute | null)[] = []
  let active: number | undefined
  let chosen: ProcedureSelection | undefined
  const getProcedureWaypoints = vi.fn(
    (_icao: string, _kind: string, identifier: string) => options.legsOf?.(identifier) ?? []
  )
  const publisher = new PlannedRoutePublisher({
    db,
    hub: { publish: (_topic, payload) => void sent.push(payload as PlannedRoute | null) },
    navdata: { getProcedureWaypoints: getProcedureWaypoints as never },
    activeFlightId: () => active,
    chosenSelection: () => chosen
  })
  return {
    db,
    aircraftId,
    sent,
    publisher,
    getProcedureWaypoints,
    setActive: (id: number | undefined) => (active = id),
    choose: (selection: ProcedureSelection | undefined) => (chosen = selection)
  }
}

const idents = (route: PlannedRoute | null | undefined): string[] =>
  route?.waypoints.map((w) => w.ident) ?? []

describe('PlannedRoutePublisher', () => {
  it('publishes nothing when there is no flight to show, and clears the route once the flight is gone', () => {
    const t = build()
    t.publisher.refresh()
    expect(t.sent).toEqual([])
    const flight = createFlight(t.db, {
      aircraftId: t.aircraftId,
      depIcao: 'EGLL',
      arrIcao: 'KJFK',
      ofpJson: OFP_JSON
    })
    t.publisher.refresh()
    expect(t.sent).toHaveLength(1)
    // Block-out with nothing tracked: no flight is left to show.
    startFlight(t.db, flight.id, 10000)
    t.publisher.refresh()
    expect(t.sent.at(-1)).toBeNull()
  })

  it("publishes the planned flight's route with SimBrief's own SID when no choice has been made", () => {
    const t = build()
    createFlight(t.db, { aircraftId: t.aircraftId, depIcao: 'EGLL', arrIcao: 'KJFK', ofpJson: OFP_JSON })
    t.publisher.refresh()
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toMatchObject({ revision: 1, selection: emptyProcedureSelection() })
    expect(idents(t.sent[0])).toEqual(['SIDFIX', 'CRUISE'])
  })

  it("uses the flight's saved choice when nothing has been chosen on a screen", () => {
    const t = build({ legsOf: (id) => (id === 'BPK7F' ? [leg('NAVSID')] : []) })
    const flight = createFlight(t.db, {
      aircraftId: t.aircraftId,
      depIcao: 'EGLL',
      arrIcao: 'KJFK',
      ofpJson: OFP_JSON
    })
    setSelectedProcedures(t.db, flight.id, {
      ...emptyProcedureSelection(),
      sidIdent: 'BPK7F',
      departureRunway: '27L'
    })
    t.publisher.refresh()
    expect(idents(t.sent[0])).toEqual(['NAVSID', 'CRUISE'])
    expect(t.getProcedureWaypoints).toHaveBeenCalledWith('EGLL', 'sid', 'BPK7F', '27L', null)
  })

  it('publishes again, one revision on, when the choice changes, and not when nothing did', () => {
    const t = build({ legsOf: (id) => [leg(id)] })
    createFlight(t.db, { aircraftId: t.aircraftId, depIcao: 'EGLL', arrIcao: 'KJFK', ofpJson: OFP_JSON })
    t.choose({ ...emptyProcedureSelection(), sidIdent: 'OLD1A', departureRunway: '21R' })
    t.publisher.refresh()
    t.publisher.refresh()
    expect(t.sent).toHaveLength(1)
    t.choose({ ...emptyProcedureSelection(), sidIdent: 'NEW1Z', departureRunway: '03L' })
    t.publisher.refresh()
    expect(t.sent.map((r) => r?.revision)).toEqual([1, 2])
    expect(idents(t.sent[1])).toContain('NEW1Z')
    expect(t.sent[1]?.selection).toMatchObject({ sidIdent: 'NEW1Z', departureRunway: '03L' })
  })

  it("builds again when the airport's navdata arrives after the first try", () => {
    let loaded = false
    const t = build({ legsOf: () => (loaded ? [leg('LATE')] : []) })
    createFlight(t.db, { aircraftId: t.aircraftId, depIcao: 'EGLL', arrIcao: 'KJFK', ofpJson: OFP_JSON })
    t.choose({ ...emptyProcedureSelection(), sidIdent: 'BPK7F' })
    t.publisher.refresh()
    expect(idents(t.sent[0])).toEqual(['SIDFIX', 'CRUISE'])
    loaded = true
    t.publisher.refresh()
    expect(idents(t.sent[1])).toEqual(['LATE', 'CRUISE'])
    expect(t.sent[1]?.revision).toBe(2)
  })

  it('starts again at revision 1 for another flight', () => {
    const t = build()
    const first = createFlight(t.db, {
      aircraftId: t.aircraftId,
      depIcao: 'EGLL',
      arrIcao: 'KJFK',
      ofpJson: OFP_JSON
    })
    t.publisher.refresh()
    t.choose({ ...emptyProcedureSelection(), sidIdent: 'X1A' })
    t.publisher.refresh()
    expect(t.sent.at(-1)?.revision).toBe(2)
    const second = createFlight(t.db, {
      aircraftId: t.aircraftId,
      depIcao: 'KJFK',
      arrIcao: 'EGLL',
      ofpJson: OFP_JSON
    })
    t.publisher.refresh()
    expect(first.id).not.toBe(second.id)
    expect(t.sent.at(-1)).toMatchObject({ flightId: second.id, revision: 1 })
  })

  it('keeps the last route and carries on when building one fails', () => {
    const t = build({
      legsOf: () => {
        throw new Error('cache unavailable')
      }
    })
    createFlight(t.db, { aircraftId: t.aircraftId, depIcao: 'EGLL', arrIcao: 'KJFK', ofpJson: OFP_JSON })
    t.choose({ ...emptyProcedureSelection(), sidIdent: 'BPK7F' })
    expect(() => t.publisher.refresh()).not.toThrow()
    expect(t.sent).toEqual([])
  })
})
