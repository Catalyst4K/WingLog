/** The route the second screen draws: the one the PC builds and pushes (winglog-backend's docs/plans/lan-sync.md). */

import { useMemo } from 'react'
import type { LanFlightSnapshot } from '@shared/ipc'
import { segmentWaypoints, type Waypoint } from '@shared/route'
import type { LanConnection } from './lan-connection'
import { useTopic } from './use-link'

/**
 * The planned route of the flight shown. The PC builds it from the flight's plan and the procedures chosen, so the page needs no
 * lookups of its own and cannot be left on an old SID by one that was lost. Until the PC has sent a route for this flight, SimBrief's
 * own route stands in, so the map is not empty; a route for another flight is never drawn.
 *
 * @param link The link to the PC.
 * @param snapshot The flight shown, with its plan, or null.
 * @returns The route's waypoints.
 */
export function usePlannedWaypoints(link: LanConnection, snapshot: LanFlightSnapshot | null): Waypoint[] {
  const route = useTopic(link, 'plannedRoute')
  const flightId = snapshot?.flight.flightId
  const ofpJson = snapshot?.flight.ofpJson ?? null
  return useMemo(() => {
    if (flightId === undefined) return []
    return route && route.flightId === flightId ? route.waypoints : segmentWaypoints(ofpJson)
  }, [route, flightId, ofpJson])
}
