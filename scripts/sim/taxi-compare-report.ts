/**
 * The taxi comparison report: every taxi, drawn twice side by side on the same map. On the left the main trace (through the cleared
 * taxiways in order), on the right the pathfinder fallback (a shortest way to where the clearance ends), so the fallback can be judged
 * against the line the app normally draws (winglog-backend docs/plans/taxi-pathfinder.md).
 */
import type { NavdataTaxiSegment } from '../../src/shared/ipc'
import { flatDistanceM } from '../../src/shared/geo'
import { matchClearance } from '../../src/renderer/src/taxi-fallback'
import type { TracedRoute } from '../../src/renderer/src/taxi-route-trace'
import type { Report, ReportSection } from './report'
import { boundsOf, makeFrame, networkLines, polyline, svg, TRACK_COLOUR, type LonLat } from './svg'
import type { TaxiRun, TaxiScenario } from './taxi'
import type { TaxiOutcome } from './taxi-report'

/** Padding around a map, in degrees (~150 m). */
const PAD_DEG = 0.0015
const MAIN_COLOUR = '#e8590c'
const FALLBACK_COLOUR = '#9c36b5'

const lengthM = (route: TracedRoute | null): number =>
  route
    ? route
        .slice(1)
        .reduce(
          (sum, p, i) =>
            sum + flatDistanceM({ lat: route[i][1], lon: route[i][0] }, { lat: p[1], lon: p[0] }),
          0
        )
    : 0

const endOf = (route: TracedRoute): { lat: number; lon: number } => ({
  lat: route.at(-1)?.[1] ?? 0,
  lon: route.at(-1)?.[0] ?? 0
})

function map(
  title: string,
  line: TracedRoute | null,
  colour: string,
  frameLines: LonLat[],
  sc: TaxiScenario,
  segments: NavdataTaxiSegment[]
): string {
  const frame = makeFrame(boundsOf(frameLines, PAD_DEG), 400, 260, 420)
  const track: LonLat[] = sc.samples.filter((s) => s.phase !== 'takeoff').map((s) => [s.lon, s.lat])
  const parts = [networkLines(frame, segments)]
  if (line) parts.push(polyline(frame, line, `stroke="${colour}" stroke-width="6" stroke-opacity="0.75"`))
  parts.push(polyline(frame, track, `stroke="${TRACK_COLOUR}" stroke-width="1.8"`))
  const start = line?.[0] ?? track[0]
  if (start)
    parts.push(
      `<circle cx="${frame.x(start[0]).toFixed(1)}" cy="${frame.y(start[1]).toFixed(1)}" r="5" fill="${colour}"/>`
    )
  return svg(frame, parts.join(''), title)
}

function matchText(run: TaxiRun, route: TracedRoute | null): string {
  const request = run.request
  if (!request || !route) return 'n/a'
  const { absent, notFollowed } = matchClearance(request, route)
  const bits = [
    absent.length > 0 ? `not in the data: ${absent.join(', ')}` : '',
    notFollowed.length > 0 ? `not followed: ${notFollowed.join(', ')}` : ''
  ].filter(Boolean)
  return bits.length > 0 ? bits.join('; ') : 'every cleared taxiway followed in order'
}

function section({ sc, run, segments }: TaxiOutcome): ReportSection {
  const clearance =
    sc.boxes.map((b) => b.info).join(' ') +
    (sc.holdShortRunway ? `, hold short of ${sc.holdShortRunway}` : '')
  const meta = `${sc.icao} · cleared ${clearance} · ${sc.source} · ${new Date(sc.atMs).toISOString().slice(0, 16)}Z`
  const part = sc.id.match(/-\d+$/)?.[0] ? ` (part ${sc.id.split('-').at(-1)})` : ''
  const title = `Flight ${sc.flightId} ${sc.side === 'out' ? 'departure' : 'arrival'}${part}`
  const main = run.exact
  const fallback = run.pathfinder
  const all: LonLat[] = [
    ...(main ?? []),
    ...(fallback ?? []),
    ...sc.samples.filter((s) => s.phase !== 'takeoff').map((s): LonLat => [s.lon, s.lat])
  ]
  if (all.length === 0) return { title, meta, metrics: [], notScored: 'No position to draw.', figures: '' }
  const apart = main && fallback ? Math.round(flatDistanceM(endOf(main), endOf(fallback))) : null
  const metrics = [
    { label: 'Main', value: main ? `${Math.round(lengthM(main))} m` : 'no trace' },
    { label: 'Fallback', value: fallback ? `${Math.round(lengthM(fallback))} m` : 'found nothing' },
    { label: 'Ends apart', value: apart === null ? 'n/a' : `${apart} m` }
  ]
  const caption = (name: string, route: TracedRoute | null): string =>
    `${name}: ${route ? matchText(run, route) : 'no line'}`
  const left = map(`${sc.id} main`, main, MAIN_COLOUR, all, sc, segments)
  const right = map(`${sc.id} fallback`, fallback, FALLBACK_COLOUR, all, sc, segments)
  const figures = `<div class="pair"><figure>${left}<figcaption>${caption('Main trace', main)}</figcaption></figure><figure>${right}<figcaption>${caption('Pathfinder fallback', fallback)}</figcaption></figure></div>`
  return { title, meta, metrics, figures }
}

/**
 * The whole comparison report.
 *
 * @param outcomes The simulated taxis.
 * @returns The report.
 */
export function taxiCompareReport(outcomes: TaxiOutcome[]): Report {
  const seen = new Set<string>()
  const unique = outcomes.filter((o) => {
    const key = `${o.sc.id}|${o.sc.boxes.map((b) => b.info).join(' ')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const both = unique.filter((o) => o.run.exact && o.run.pathfinder)
  const close = both.filter(
    (o) => flatDistanceM(endOf(o.run.exact as TracedRoute), endOf(o.run.pathfinder as TracedRoute)) <= 30
  ).length
  return {
    title: 'Taxi line: main trace against the pathfinder fallback',
    intro: `${unique.length} real taxis from WingLog's own flights and logs, each drawn with the app's normal trace and with the fallback that takes over when the trace fails. The blue line is the real taxi.`,
    lookFor: [
      'Does the pathfinder (right) start at the aircraft and end at the same hold short or stand as the main trace (left)?',
      'Where the two differ, is the pathfinder still a sensible way to where the aircraft was cleared?',
      'The line under each map says which cleared taxiways it follows, in order.'
    ],
    key: [
      { colour: MAIN_COLOUR, label: 'Main trace through the cleared taxiways' },
      { colour: FALLBACK_COLOUR, label: 'Pathfinder fallback' },
      { colour: TRACK_COLOUR, label: 'The real taxi' }
    ],
    summary: [
      { label: 'Taxis', value: String(unique.length) },
      { label: 'Both lines found', value: String(both.length) },
      { label: 'Same end (within 30 m)', value: `${close} of ${both.length}` }
    ],
    sections: unique.map(section)
  }
}
