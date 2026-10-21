/** The live route the renderer draws from the SID, STAR and approach selection, fetching each procedure's legs over IPC. */

import { winglogApi } from './data/winglog-api'
import { useEffect, useMemo, useState } from 'react'
import type { NavdataLeg, ProcedureSelection } from '@shared/ipc'
import {
  assembleRoute,
  procedureRequests,
  type ProcedureAirports,
  type ProcedureRequest
} from '@shared/procedure-selection'
import type { Waypoint } from '@shared/route'

/** How long a failed legs fetch waits before its one retry, in milliseconds. */
const RETRY_MS = 2000

/** The legs a fetch returned, tagged with the lookup they answer, so a resolving fetch can be checked against the *current*
 *  selection before it's used (see useLiveWaypoints's own comment for why this exists). */
interface FetchedLegs {
  key: string
  legs: NavdataLeg[]
}

/**
 * @param request A legs lookup.
 * @returns A text that is the same for the same lookup.
 */
function requestKey(request: ProcedureRequest): string {
  return JSON.stringify([request.icao, request.kind, request.identifier, request.runway, request.transition])
}

/**
 * Fetches one procedure's legs, tagged with the lookup they were fetched for. A failure is tried once more after RETRY_MS (the main
 * process can be busy for a moment), and an empty list stands in for one that fails twice.
 *
 * @param request The lookup.
 * @param set Receives the legs, unless the returned cleanup ran first.
 * @returns The effect cleanup: a fetch still in flight, or waiting to retry, is then ignored.
 */
function fetchProcedureLegs(request: ProcedureRequest, set: (fetched: FetchedLegs) => void): () => void {
  let ignore = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const key = requestKey(request)
  const attempt = (again: boolean): void => {
    winglogApi()
      .navdataGetProcedureWaypoints(
        request.icao,
        request.kind,
        request.identifier,
        request.runway,
        request.transition
      )
      .then((legs) => {
        if (!ignore) set({ key, legs })
      })
      .catch(() => {
        if (ignore) return
        if (again) retry = setTimeout(() => attempt(false), RETRY_MS)
        else set({ key, legs: [] })
      })
  }
  attempt(true)
  return () => {
    ignore = true
    clearTimeout(retry)
  }
}

/**
 * The legs of one procedure, fetched when its lookup changes. Legs fetched for an earlier lookup are never returned: until the new
 * ones arrive the result is null, and the route keeps SimBrief's own segment.
 *
 * @param request The lookup, or null when the procedure isn't selected. Must be stable between renders.
 * @returns The legs for exactly this lookup, or null.
 */
function useProcedureLegs(request: ProcedureRequest | null): NavdataLeg[] | null {
  const [fetched, setFetched] = useState<FetchedLegs | null>(null)
  // None of the effects reset their legs state when the procedure goes null — deliberately: a stale array left over from a previous
  // selection is inert, since it is only returned when its key matches the current lookup. The `ignore` flag in the cleanup stops a
  // stale fetch from setting state after a newer one has started.
  useEffect(() => (request ? fetchProcedureLegs(request, setFetched) : undefined), [request])
  return request && fetched?.key === requestKey(request) ? fetched.legs : null
}

/**
 * Fetches real navdata legs for whatever's currently selected and assembles the live waypoint list — the same assembly the main
 * process does to push the route to a second screen (`assembleRoute`), so the two can never disagree (winglog-backend's
 * docs/plans/navdata-without-navigraph.md Phase 5 and docs/plans/lan-sync.md). Every fetch is a local SQLite cache read, not a live
 * sim round-trip, so refetching on every selection change is cheap.
 *
 * @param airports The flight's airports and OFP, or null.
 * @param selection The selection.
 * @returns The route's waypoints with the selected procedures spliced in.
 */
export function useLiveWaypoints(
  airports: ProcedureAirports | null,
  selection: ProcedureSelection
): Waypoint[] {
  const { departureRunway, sidIdent, sidTransition, starIdent, starTransition } = selection
  const { approachIdent, approachTransition, arrivalIcao } = selection
  const depIcao = airports?.depIcao
  const arrIcao = airports?.arrIcao
  const ofpJson = airports?.ofpJson ?? null
  // The airports object is recreated by callers on every render, so everything below keys on its fields. Its stable `requests`
  // identity is what keeps the three fetch effects from re-firing.
  const requests = useMemo(
    () =>
      depIcao && arrIcao
        ? procedureRequests(
            { depIcao, arrIcao, ofpJson: null },
            {
              departureRunway,
              sidIdent,
              sidTransition,
              starIdent,
              starTransition,
              approachIdent,
              approachTransition,
              arrivalIcao
            }
          )
        : null,
    [
      depIcao,
      arrIcao,
      departureRunway,
      sidIdent,
      sidTransition,
      starIdent,
      starTransition,
      approachIdent,
      approachTransition,
      arrivalIcao
    ]
  )
  const sid = useProcedureLegs(requests?.sid ?? null)
  const star = useProcedureLegs(requests?.star ?? null)
  const approach = useProcedureLegs(requests?.approach ?? null)
  const altnIcao = airports?.altnIcao

  // Memoized so callers that key their own effects off this result (e.g. LogbookView's great-circle-fallback check) see a stable
  // reference across renders that don't actually change anything here, not a fresh array every time.
  return useMemo(
    () =>
      depIcao && arrIcao
        ? assembleRoute(
            { depIcao, arrIcao, altnIcao, ofpJson },
            {
              departureRunway,
              sidIdent,
              sidTransition,
              starIdent,
              starTransition,
              approachIdent,
              approachTransition,
              arrivalIcao
            },
            { sid, star, approach }
          )
        : [],
    [
      depIcao,
      arrIcao,
      altnIcao,
      ofpJson,
      departureRunway,
      sidIdent,
      sidTransition,
      starIdent,
      starTransition,
      approachIdent,
      approachTransition,
      arrivalIcao,
      sid,
      star,
      approach
    ]
  )
}
