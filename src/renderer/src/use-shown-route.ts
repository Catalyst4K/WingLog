/** The route drawn for the flight shown: the one the main process built for it, else the window's own assembly. */

import type { ProcedureAirports } from '@shared/procedure-selection'
import type { ProcedureSelection } from '@shared/ipc'
import type { Waypoint } from '@shared/route'
import { useLiveTopic } from './live/LiveClient'
import { useLiveWaypoints } from './procedure-selection'

/**
 * The planned route of the flight shown. For a saved flight it is the route the main process built from the flight's plan and the
 * procedures chosen, the same one every second screen draws (winglog-backend's docs/plans/taxi-and-second-screen-robustness.md, D1), so
 * the window and a phone cannot disagree. Until main has sent a route for this flight, and for a plan that is not a flight yet
 * (Dispatch's fetched OFP), the window assembles one itself from the same shared function; a route for another flight is never drawn.
 *
 * @param flight The saved flight shown, or undefined for an unsaved plan or none.
 * @param airports The flight's (or plan's) airports and OFP, or null.
 * @param selection The window's procedure selection, used for its own assembly.
 * @returns The route's waypoints.
 */
export function useShownRoute(
  flight: { id: number } | undefined,
  airports: ProcedureAirports | null,
  selection: ProcedureSelection
): Waypoint[] {
  const planned = useLiveTopic('plannedRoute', null)
  const fromMain = flight !== undefined && planned?.flightId === flight.id ? planned : null
  // With the main process's route there is nothing to assemble: no procedure legs are fetched for it.
  const assembled = useLiveWaypoints(fromMain ? null : airports, selection)
  return fromMain ? fromMain.waypoints : assembled
}
