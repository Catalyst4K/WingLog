/** The route of a flight with a choice of procedures spliced in, from the cached procedure legs. */

import type { Flight, NavdataLeg, ProcedureSelection } from '@shared/ipc'
import {
  assembleRoute,
  procedureRequests,
  type FetchedProcedureLegs,
  type ProcedureRequest
} from '@shared/procedure-selection'
import type { Waypoint } from '@shared/route'
import type { NavdataProvider } from './navdata-provider'

/** The route and how many legs each procedure brought. */
export interface AssembledFlightRoute {
  waypoints: Waypoint[]
  legCounts: { sid: number; star: number; approach: number }
}

/**
 * The flight's planned route with the SID, STAR and approach chosen put in: the one the second screen is sent
 * (PlannedRoutePublisher), and the one the suggested approach is judged against (ProcedureSelectionStore: where the STAR ends).
 *
 * @param flight The flight, for its airports and plan.
 * @param selection The choice in force.
 * @param navdata The cached procedure legs.
 * @returns The route and the legs each procedure brought.
 */
export function assembleFlightRoute(
  flight: Pick<Flight, 'depIcao' | 'arrIcao' | 'ofpJson'>,
  selection: ProcedureSelection,
  navdata: Pick<NavdataProvider, 'getProcedureWaypoints'>
): AssembledFlightRoute {
  const airports = { depIcao: flight.depIcao, arrIcao: flight.arrIcao, ofpJson: flight.ofpJson }
  const requests = procedureRequests(airports, selection)
  const legs = (request: ProcedureRequest | null): NavdataLeg[] | null =>
    request
      ? navdata.getProcedureWaypoints(
          request.icao,
          request.kind,
          request.identifier,
          request.runway,
          request.transition
        )
      : null
  const fetched: FetchedProcedureLegs = {
    sid: legs(requests.sid),
    star: legs(requests.star),
    approach: legs(requests.approach)
  }
  return {
    waypoints: assembleRoute(airports, selection, fetched),
    legCounts: {
      sid: fetched.sid?.length ?? 0,
      star: fetched.star?.length ?? 0,
      approach: fetched.approach?.length ?? 0
    }
  }
}
