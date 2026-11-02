/**
 * `npm run sim -- route-unplaced`: a flight's planned route when one approach fix arrives from the sim with no position, as EGCC's
 * did for flight 259 while the sim was loading (winglog-backend docs/navdata-notes.md, 2026-11-02). Built by the real route assembly
 * from this machine's cached navdata, read-only: once from the cache as it is, and once with the approach's first fix moved to 0,0.
 * "Before" is the good route with that fix at 0,0, which is what the old code drew; "after" is what the code draws now. Set
 * WINGLOG_SIM_FLIGHT to use another flight (default 259). Writes release/sim/route-unplaced/index.html (gitignored).
 */
import { it } from 'vitest'
import { greatCircleNm } from '../../src/shared/geo'
import { selectionFromFlight } from '../../src/shared/procedure-selection'
import type { Waypoint } from '../../src/shared/route'
import { getFlight } from '../../src/main/db/flight-repo'
import { listCachedProcedureLegs } from '../../src/main/db/navdata-repo'
import { assembleFlightRoute } from '../../src/main/navdata/assemble-flight-route'
import type { NavdataProvider } from '../../src/main/navdata/navdata-provider'
import { openUserDb } from './local-data'
import { writeReport, type ReportSection } from './report'
import { boundsOf, makeFrame, polyline, svg, TRACK_COLOUR, type LonLat } from './svg'

const APPROACH_COLOUR = '#2f9e44' // map-layers.ts's approach colour

/** The route drawn on a map of its own extent, with each waypoint dotted and the approach's in green. */
function routeFigure(waypoints: Waypoint[], caption: string): string {
  const points: LonLat[] = waypoints.map((w) => [w.lon, w.lat])
  const frame = makeFrame(boundsOf(points, 1), 380, 260, 520)
  const dots = waypoints
    .map(
      (w) =>
        `<circle cx="${frame.x(w.lon).toFixed(1)}" cy="${frame.y(w.lat).toFixed(1)}" r="3.5" fill="${w.segment === 'approach' ? APPROACH_COLOUR : TRACK_COLOUR}"/>`
    )
    .join('')
  const map = svg(
    frame,
    polyline(frame, points, `fill="none" stroke="${TRACK_COLOUR}" stroke-width="2"`) + dots,
    caption
  )
  return `<figure>${map}<figcaption>${caption}</figcaption></figure>`
}

it('draws a route with an approach fix that has no position', () => {
  const flightId = Number(process.env.WINGLOG_SIM_FLIGHT ?? 259)
  const { db, close } = openUserDb()
  try {
    const flight = getFlight(db, flightId)
    if (!flight) throw new Error(`Flight ${flightId} is not in the logbook`)
    const selection = selectionFromFlight(flight)
    const cached: Pick<NavdataProvider, 'getProcedureWaypoints'> = {
      getProcedureWaypoints: (icao, kind, identifier, runway, transition) =>
        listCachedProcedureLegs(db, icao, kind, identifier, runway, transition)
    }
    const unplacedFirstApproachFix: Pick<NavdataProvider, 'getProcedureWaypoints'> = {
      getProcedureWaypoints: (icao, kind, identifier, runway, transition) => {
        const legs = cached.getProcedureWaypoints(icao, kind, identifier, runway, transition)
        if (kind !== 'approach') return legs
        const first = legs.findIndex((leg) => leg.fixIdent !== null)
        return legs.map((leg, i) => (i === first ? { ...leg, fixLatitude: 0, fixLongitude: 0 } : leg))
      }
    }
    const good = assembleFlightRoute(flight, selection, cached).waypoints
    const after = assembleFlightRoute(flight, selection, unplacedFirstApproachFix).waypoints
    const moved = good.find((w) => w.segment === 'approach')
    if (!moved) throw new Error(`Flight ${flightId}'s route has no approach in the cache to move`)
    const before = good.map((w) => (w === moved ? { ...w, lat: 0, lon: 0 } : w))

    const destination = good.at(-1) ?? moved
    const farthestNm = (route: Waypoint[]): string =>
      `${Math.round(Math.max(...route.map((w) => greatCircleNm(w, destination))))} nm`
    const section: ReportSection = {
      title: `Flight ${flightId}: ${flight.depIcao} to ${flight.arrIcao}, ${moved.ident} with no position`,
      meta: `The ${selection.approachIdent ?? 'approach'}'s first fix (${moved.ident}) moved to 0,0, as the sim handed EGCC's over on flight 259 while it was loading.`,
      metrics: [
        { label: 'Waypoints drawn', value: String(after.length), was: String(before.length) },
        { label: 'Farthest waypoint from the runway', value: farthestNm(after), was: farthestNm(before) },
        {
          label: `${moved.ident} drawn`,
          value: after.some((w) => w.ident === moved.ident) ? 'yes' : 'no',
          was: 'yes, at 0,0'
        }
      ],
      figures: `<div class="pair">${routeFigure(before, 'Before: drawn at 0,0, off West Africa')}${routeFigure(after, `After: left out; the route goes from the STAR to the next approach fix`)}</div>`
    }
    const page = writeReport(
      'route-unplaced',
      {
        title: 'A fix with no position',
        intro:
          `Flight ${flightId}'s planned route, built by the real route assembly from this machine's cached navdata, with one approach fix ` +
          'given no position. The sim itself is no longer the source of such a fix: a fetch with one is refused and the cached data kept, ' +
          'so this is the drawing guard for one already in the cache.',
        lookFor: [
          'Before: one green point far south, with lines to it from the STAR and back to the approach.',
          'After: the route ends at the runway with no point away from it.'
        ],
        key: [
          { colour: TRACK_COLOUR, label: 'route and its waypoints' },
          { colour: APPROACH_COLOUR, label: 'approach waypoints' }
        ],
        summary: [{ label: 'Fix moved', value: moved.ident }],
        sections: [section]
      },
      { flightId, moved: moved.ident, before: before.length, after: after.length }
    )
    process.stdout.write(`route-unplaced report: ${page}\n`)
  } finally {
    close()
  }
})
