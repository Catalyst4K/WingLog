/**
 * The taxi simulation's report: per taxi, an overview map (network, the cleared line, each
 * re-route, the real track) and a before-and-after pair at every re-route, zoomed in on the
 * aircraft (winglog-backend docs/plans/robustness/scenario-testing.md Part 6, "Visual output").
 */
import type { NavdataTaxiSegment } from '../../src/shared/ipc'
import type { Report, ReportSection } from './report'
import {
  aircraftMarker,
  boundsAround,
  boundsOf,
  makeFrame,
  networkLines,
  polyline,
  STEP_COLOURS,
  stepMarker,
  svg,
  TAXI_LINE_COLOUR,
  TRACK_COLOUR,
  type LonLat
} from './svg'
import type { Reroute, TaxiRun, TaxiScenario } from './taxi'

/** Padding around an overview map, in degrees (~150 m). */
const OVERVIEW_PAD_DEG = 0.0015
/** Half the width of a before-and-after panel, in metres. */
const PANEL_HALF_M = 500

const trackOf = (sc: TaxiScenario): LonLat[] => sc.samples.filter((s) => s.phase !== 'takeoff').map((s) => [s.lon, s.lat])

function overview(sc: TaxiScenario, run: TaxiRun, segments: NavdataTaxiSegment[]): string {
  const track = trackOf(sc)
  const all = [...track, ...(run.cleared ?? []), ...run.reroutes.flatMap((r) => r.after)]
  const frame = makeFrame(boundsOf(all, OVERVIEW_PAD_DEG), 760, 240, 760)
  const parts = [networkLines(frame, segments)]
  if (run.cleared) parts.push(polyline(frame, run.cleared, `stroke="${TAXI_LINE_COLOUR}" stroke-width="7" stroke-opacity="0.5"`))
  run.reroutes.forEach((r, i) => parts.push(polyline(frame, r.after, `stroke="${STEP_COLOURS[i % STEP_COLOURS.length]}" stroke-width="2.5" stroke-dasharray="6 4"`)))
  parts.push(polyline(frame, track, `stroke="${TRACK_COLOUR}" stroke-width="2"`))
  if (track[0]) parts.push(`<circle cx="${frame.x(track[0][0]).toFixed(1)}" cy="${frame.y(track[0][1]).toFixed(1)}" r="5" fill="${TRACK_COLOUR}"/>`)
  run.reroutes.forEach((r, i) => parts.push(stepMarker(frame, r.at, String(i + 1), STEP_COLOURS[i % STEP_COLOURS.length])))
  if (run.stand) {
    const x = frame.x(run.stand.lon)
    const y = frame.y(run.stand.lat)
    parts.push(`<rect x="${(x - 6).toFixed(1)}" y="${(y - 6).toFixed(1)}" width="12" height="12" fill="none" stroke="var(--fg)" stroke-width="2"/>`)
  }
  return svg(frame, parts.join(''), `${sc.id} overview`)
}

function panel(sc: TaxiScenario, reroute: Reroute, line: LonLat[], segments: NavdataTaxiSegment[], label: string): string {
  const frame = makeFrame(boundsAround(reroute.at, PANEL_HALF_M), 360, 360, 360)
  const track = trackOf(sc)
  const split = sc.samples.findIndex((s) => s.tMs >= reroute.tMs)
  const flown = split < 0 ? track : track.slice(0, split + 1)
  const ahead = split < 0 ? [] : track.slice(split)
  const parts = [
    networkLines(frame, segments),
    polyline(frame, flown, `stroke="${TRACK_COLOUR}" stroke-width="2"`),
    polyline(frame, ahead, `stroke="${TRACK_COLOUR}" stroke-width="1.5" stroke-dasharray="2 4" stroke-opacity="0.8"`),
    polyline(frame, line, `stroke="${TAXI_LINE_COLOUR}" stroke-width="4"`),
    aircraftMarker(frame, reroute.at, reroute.headingDeg)
  ]
  return `<figure>${svg(frame, parts.join(''), `${sc.id} ${label}`)}<figcaption>${label}</figcaption></figure>`
}

function steps(sc: TaxiScenario, run: TaxiRun, segments: NavdataTaxiSegment[]): string {
  return run.reroutes
    .map((r, i) => {
      const seconds = Math.round((r.tMs - sc.atMs) / 1000)
      const colour = STEP_COLOURS[i % STEP_COLOURS.length]
      return `<h3><span class="dot" style="background:${colour}"></span>Re-route ${i + 1}, ${seconds} s after the clearance</h3><div class="pair">${panel(sc, r, r.before, segments, 'Just before')}${panel(sc, r, r.after, segments, 'Just after')}</div>`
    })
    .join('')
}

export interface TaxiOutcome {
  sc: TaxiScenario
  run: TaxiRun
  baseline: TaxiRun
  segments: NavdataTaxiSegment[]
}

function section({ sc, run, baseline, segments }: TaxiOutcome): ReportSection {
  const clearance = sc.boxes.map((b) => b.info).join(' ') + (sc.holdShortRunway ? `, hold short of ${sc.holdShortRunway}` : '')
  const meta = `${sc.icao} · cleared ${clearance} · ${sc.source} · ${new Date(sc.atMs).toISOString().slice(0, 16)}Z`
  const title = `Flight ${sc.flightId} ${sc.side === 'out' ? 'departure' : 'arrival'}${sc.id.match(/-\d+$/)?.[0] ? ` (part ${sc.id.split('-').at(-1)})` : ''}`
  if (!run.cleared) {
    return { title, meta, metrics: [], notScored: 'No line could be traced for this clearance (not on the cached network, or no position), so the app showed whole taxiways.', figures: '' }
  }
  return {
    title,
    meta,
    notScored: sc.notScored,
    metrics: [
      { label: 'Re-routes', value: String(run.reroutes.length) },
      { label: 'On the line while moving', value: run.onLinePct === null ? 'n/a' : `${run.onLinePct}%`, was: baseline.onLinePct === null ? undefined : `${baseline.onLinePct}%` },
      { label: 'Line end to the aircraft, closest', value: run.endToAircraftM === null ? 'n/a' : `${Math.round(run.endToAircraftM)} m` }
    ],
    figures: overview(sc, run, segments) + steps(sc, run, segments)
  }
}

/** The whole report. */
export function taxiReport(outcomes: TaxiOutcome[]): Report {
  const scored = outcomes.filter((o) => o.run.cleared && !o.sc.notScored && o.run.onLinePct !== null)
  const mean = (values: number[]): string => (values.length ? `${Math.round(values.reduce((a, b) => a + b, 0) / values.length)}%` : 'n/a')
  return {
    title: 'Taxi Line Simulation',
    intro:
      'Your real taxis, replayed through the app’s own taxi line code (the same functions the Track map runs on every position update), with the clearance BeyondATC actually gave. Positions are the recorded track, every 1-3 s. "Today" is the line without re-routing.',
    lookFor: [
      'The line never points behind the aircraft.',
      'The line runs along the taxilane, never in and out of gate lead-ins.',
      'After a re-route, the line rejoins the cleared route where you would expect, not by a detour.',
      'The line ends at the holding point or the stand you were cleared to.'
    ],
    key: [
      { colour: TAXI_LINE_COLOUR, label: 'taxi line' },
      { colour: TRACK_COLOUR, label: 'your real track (dot: clearance received)' },
      { colour: STEP_COLOURS[0], label: 're-routes, numbered where they fired' }
    ],
    summary: [
      { label: 'Taxis', value: String(outcomes.length) },
      { label: 'Traced', value: String(outcomes.filter((o) => o.run.cleared).length) },
      { label: 'On the line while moving (scored taxis)', value: `${mean(scored.map((o) => o.run.onLinePct as number))}, today ${mean(scored.map((o) => o.baseline.onLinePct ?? 0))}` },
      { label: 'Re-routes', value: String(outcomes.reduce((n, o) => n + o.run.reroutes.length, 0)) }
    ],
    sections: outcomes.map(section)
  }
}
