/**
 * Whether a traced taxi route drives a taxiway more often than the clearance names it (winglog-backend's
 * docs/plans/taxi-routing-rules.md, rule 10). ATC's route never has the pilot leave a taxiway and come back to it unless it says so
 * ("C, D, C"). A trace that does has had to double back to reach a cleared taxiway the aircraft is already past: EGLL flight 239's
 * second clearance came while it taxied east on S, 80 m past S3, the first cleared taxiway, and the line lapped 700 m round LINK 41
 * and back along S to reach it (S twice); joining at L or B instead drove A, back to B, and A again.
 */
import type { NavdataTaxiSegment } from '@shared/ipc'
import { itemAt } from '@shared/item-at'
import { nodeKey, type TracedRoute } from './taxi-route-trace'

/**
 * The named taxiways a route drives, in order, one entry per run: unnamed segments (fillets, lead-ins) don't break a run.
 *
 * @param route The route.
 * @param segments The taxi network it was traced on.
 * @returns The runs' names.
 */
export function namedRuns(route: TracedRoute, segments: NavdataTaxiSegment[]): string[] {
  const names = new Map<string, string>()
  for (const s of segments) {
    if (s.name === null) continue
    const a = nodeKey(s.startLat, s.startLon)
    const b = nodeKey(s.endLat, s.endLon)
    names.set(`${a}>${b}`, s.name)
    names.set(`${b}>${a}`, s.name)
  }
  const runs: string[] = []
  for (let i = 0; i + 1 < route.length; i++) {
    const [aLon, aLat] = itemAt(route, i, 'route point')
    const [bLon, bLat] = itemAt(route, i + 1, 'route point')
    const name = names.get(`${nodeKey(aLat, aLon)}>${nodeKey(bLat, bLon)}`)
    if (name !== undefined && runs.at(-1) !== name) runs.push(name)
  }
  return runs
}

/**
 * @param route The traced route.
 * @param segments The taxi network.
 * @param cleared The cleared taxiways and the holding point, as ATC said them.
 * @returns True if the route drives some taxiway in more runs than the clearance names it (once for one it doesn't name).
 */
export function drivesTaxiwayAgain(
  route: TracedRoute,
  segments: NavdataTaxiSegment[],
  cleared: string[]
): boolean {
  const driven = new Map<string, number>()
  for (const name of namedRuns(route, segments)) driven.set(name, (driven.get(name) ?? 0) + 1)
  for (const [name, times] of driven)
    if (times > Math.max(1, cleared.filter((c) => c === name).length)) return true
  return false
}
