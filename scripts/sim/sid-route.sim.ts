/**
 * The route a second screen is sent when a SID clearance is accepted, replayed from a recorded flight: the flight's plan, then
 * BeyondATC's clearance applied, through the real planned-route publisher against this machine's cached navdata (winglog-backend's
 * docs/plans/lan-sync.md, step 1). Set WINGLOG_SIM_CAPTURE to use another capture.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { ProcedureSelection } from '../../src/shared/ipc'
import type { PlannedRoute } from '../../src/shared/live'
import { parseAtcBoxClearance } from '../../src/shared/atc-info-boxes'
import { applyClearance, seedProcedureSelectionFromOfp } from '../../src/shared/procedure-selection'
import { getFlight } from '../../src/main/db/flight-repo'
import { listCachedProcedureLegs } from '../../src/main/db/navdata-repo'
import { PlannedRoutePublisher } from '../../src/main/lan/PlannedRoutePublisher'
import { parseFlightFixture } from '../../src/main/sim/flight-fixture'
import { findCapture } from './flight'
import { openUserDb, userDataDir } from './local-data'
import { simOutputDir } from './report'
import { join } from 'node:path'

it('the route sent follows an accepted SID clearance', () => {
  const capture = parseFlightFixture(
    readFileSync(findCapture(userDataDir(), process.env.WINGLOG_SIM_CAPTURE), 'utf8')
  )
  const flightId = (capture.header as unknown as { flightId: number }).flightId
  const { db, close } = openUserDb()
  try {
    const flight = getFlight(db, flightId)
    if (!flight) throw new Error('The capture has no flight in the database')
    const planned = seedProcedureSelectionFromOfp(flight.ofpJson ?? null)
    const event = capture.events.find(
      (e) =>
        e.type === 'beyondatc' &&
        e.direction === 'in' &&
        e.text.startsWith('InfoBoxes: ') &&
        e.text.includes('"SID"')
    )
    const clearance =
      event && parseAtcBoxClearance(JSON.parse((event as { text: string }).text.slice('InfoBoxes: '.length)))
    if (!clearance) throw new Error('No departure clearance in the capture')

    let chosen: ProcedureSelection | undefined = planned
    const sent: PlannedRoute[] = []
    const publisher = new PlannedRoutePublisher({
      db,
      hub: { publish: (_topic, payload) => void (payload && sent.push(payload as PlannedRoute)) },
      navdata: {
        getProcedureWaypoints: (icao, kind, identifier, runway, transition) =>
          listCachedProcedureLegs(db, icao, kind, identifier, runway ?? null, transition ?? null)
      },
      activeFlightId: () => flightId,
      chosenSelection: () => chosen
    })
    publisher.refresh()
    chosen = applyClearance(planned, clearance.fields)
    publisher.refresh()
    publisher.refresh() // nothing changed: nothing is sent again

    const sidOf = (route: PlannedRoute): string[] =>
      route.waypoints.filter((w) => w.segment === 'sid').map((w) => w.ident)
    writeFileSync(
      join(simOutputDir('sid'), 'route.txt'),
      JSON.stringify(
        sent.map((r) => ({ revision: r.revision, sid: r.selection.sidIdent, fixes: sidOf(r) })),
        null,
        1
      )
    )
    expect(sent.map((r) => r.revision)).toEqual([1, 2])
    expect(sidOf(sent[0]!)).not.toEqual(sidOf(sent[1]!))
    expect(sent[1]!.selection.sidIdent).toBe(clearance.fields.sidIdent)
  } finally {
    close()
  }
})
