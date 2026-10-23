/**
 * Builds the planned route of the flight the second screen shows and publishes it as the `plannedRoute` live topic (winglog-backend's
 * docs/plans/lan-sync.md, step 1). The phone draws what it is sent instead of fetching each procedure's legs over the network, so a
 * lookup that is dropped or fails can no longer leave it on SimBrief's own SID after the pilot has chosen another.
 */

import type { Flight, ProcedureSelection } from '@shared/ipc'
import type { PlannedRoute } from '@shared/live'
import { selectionFromFlight } from '@shared/procedure-selection'
import type { Waypoint } from '@shared/route'
import type { WingLogDb } from '../db/client'
import { getLiveFlight } from '../db/flight-repo'
import { logger } from '../logging/logger'
import type { LiveHub } from '../live/LiveHub'
import { assembleFlightRoute } from '../navdata/assemble-flight-route'
import type { NavdataProvider } from '../navdata/navdata-provider'
import { shownFlightId } from './lan-flight'

/** What the publisher needs from the rest of the app. */
export interface PlannedRoutePublisherDeps {
  db: WingLogDb
  hub: Pick<LiveHub, 'publish'>
  /** The cached procedure legs. */
  navdata: Pick<NavdataProvider, 'getProcedureWaypoints'>
  /** The flight being tracked, if any. */
  activeFlightId(): number | undefined
  /** The SID, STAR and approach last chosen on any screen, when there is one (the flight's saved choice otherwise). */
  chosenSelection(): ProcedureSelection | undefined
}

/** Publishes the planned route of the flight the second screen shows, whenever it changes. */
export class PlannedRoutePublisher {
  private flightId: number | null = null
  private revision = 0
  private lastKey = ''
  private last: PlannedRoute | null = null
  private published = 0

  constructor(private readonly deps: PlannedRoutePublisherDeps) {}

  /** @returns How many routes have been published so far. */
  get publishedCount(): number {
    return this.published
  }

  /**
   * Sends the route last published again, unchanged (same revision). A device that chose something the PC already had gets no new
   * route to confirm its choice with, so the PC answers it with this one.
   */
  resend(): void {
    if (this.last) this.deps.hub.publish('plannedRoute', this.last)
  }

  /** Works out the route now and publishes it if it is not the one already published. Safe to call as often as anything might have changed. */
  refresh(): void {
    try {
      this.publishIfChanged()
    } catch (error) {
      // A failed refresh must never stop the callers (a tracking event, a navdata refresh): the phone keeps the last route it was sent.
      logger.warn('[lan] could not build the planned route:', error)
    }
  }

  private publishIfChanged(): void {
    const { db, hub } = this.deps
    const id = shownFlightId(db, this.deps.activeFlightId())
    const flight = id === undefined ? undefined : getLiveFlight(db, id)
    if (!flight) {
      if (this.flightId !== null) {
        this.flightId = null
        this.lastKey = ''
        this.last = null
        this.published += 1
        hub.publish('plannedRoute', null)
      }
      return
    }
    const { selection, waypoints, legCounts } = this.build(flight)
    const key = JSON.stringify([selection, waypoints])
    if (flight.id === this.flightId && key === this.lastKey) return
    this.revision = flight.id === this.flightId ? this.revision + 1 : 1
    this.flightId = flight.id
    this.lastKey = key
    const route: PlannedRoute = { flightId: flight.id, revision: this.revision, selection, waypoints }
    this.last = route
    this.published += 1
    hub.publish('plannedRoute', route)
    logger.info(
      `[lan] route for flight ${flight.id} r${route.revision}: SID ${selection.sidIdent ?? '-'} ${selection.departureRunway ?? '-'}, STAR ${selection.starIdent ?? '-'}, approach ${selection.approachIdent ?? '-'} (sid ${legCounts.sid}, star ${legCounts.star}, approach ${legCounts.approach} legs)`
    )
  }

  /**
   * @param flight The flight shown.
   * @returns The choice in force for it, the route built from it, and how many legs each procedure brought.
   */
  private build(flight: Flight): {
    selection: ProcedureSelection
    waypoints: Waypoint[]
    legCounts: { sid: number; star: number; approach: number }
  } {
    const selection = this.deps.chosenSelection() ?? selectionFromFlight(flight)
    return { selection, ...assembleFlightRoute(flight, selection, this.deps.navdata) }
  }
}
