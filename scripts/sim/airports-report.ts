/**
 * The airport rules' report: a table of every airport checked, then a map for each failing route, so a failure is quick to judge
 * (winglog-backend docs/plans/robustness/scenario-testing.md Part 3, "A failure prints the airport, the clearance and a small map").
 */
import type { NavdataTaxiSegment } from '../../src/shared/ipc'
import type { TracedRoute } from '../../src/renderer/src/taxi-route-trace'
import type { GeneratedClearance, RuleFailure } from './airport-rules'
import type { Report, ReportSection } from './report'
import {
  aircraftMarker,
  boundsOf,
  escapeHtml,
  makeFrame,
  networkLines,
  polyline,
  svg,
  TAXI_LINE_COLOUR,
  TRACK_COLOUR,
  type LonLat
} from './svg'

/** Padding around a failing route's map, in degrees (~110 m). */
const MAP_PAD_DEG = 0.001
/** Failing routes drawn per airport; the count of the rest is still listed. */
const MAPS_PER_AIRPORT = 3
/** Airports with a section; the summary counts them all. */
const MAX_SECTIONS = 30

/** One generated clearance's outcome. */
export interface ClearanceOutcome {
  generated: GeneratedClearance
  route: TracedRoute | null
  failures: RuleFailure[]
}

/** One airport's outcomes. */
export interface AirportOutcome {
  icao: string
  segments: NavdataTaxiSegment[]
  standCount: number
  outcomes: ClearanceOutcome[]
}

const failedCount = (airport: AirportOutcome): number =>
  airport.outcomes.filter((o) => o.failures.length > 0).length

/**
 * @param outcome One clearance's outcome.
 * @returns The clearance as ATC would say it.
 */
function clearanceText({ generated }: ClearanceOutcome): string {
  const c = generated.clearance
  const via = c.taxiways.join(', ')
  if (generated.kind === 'stand') return `taxi to stand ${c.stand} via ${via}`
  if (generated.kind === 'holding point') return `taxi to holding point ${c.holdingPoint} via ${via}`
  return `taxi via ${via}, hold short of the runway`
}

/**
 * @param segments The airport's network.
 * @param outcome A failing clearance.
 * @returns A map of the network, the walk the clearance came from, and the traced route.
 */
function figure(segments: NavdataTaxiSegment[], outcome: ClearanceOutcome): string {
  const { generated, route, failures } = outcome
  const points: LonLat[] = [...generated.walk, ...(route ?? [])]
  const frame = makeFrame(boundsOf(points, MAP_PAD_DEG), 380, 260, 520)
  const parts = [
    networkLines(frame, segments),
    polyline(
      frame,
      generated.walk,
      `stroke="${TRACK_COLOUR}" stroke-width="2" stroke-dasharray="2 4" stroke-opacity="0.9"`
    )
  ]
  if (route) parts.push(polyline(frame, route, `stroke="${TAXI_LINE_COLOUR}" stroke-width="4"`))
  const from = generated.clearance.from
  if (from) parts.push(aircraftMarker(frame, from, 0))
  const why = failures.map((f) => `${f.rule}: ${f.detail}`).join('; ')
  const text = clearanceText(outcome)
  return `<figure>${svg(frame, parts.join(''), text)}<figcaption>${escapeHtml(text)}<br>${escapeHtml(why)}</figcaption></figure>`
}

/**
 * @param airport An airport with at least one failing clearance.
 * @returns Its section.
 */
function section(airport: AirportOutcome): ReportSection {
  const failing = airport.outcomes.filter((o) => o.failures.length > 0)
  const rules = new Map<string, number>()
  for (const o of failing) for (const f of o.failures) rules.set(f.rule, (rules.get(f.rule) ?? 0) + 1)
  return {
    title: airport.icao,
    meta: `${airport.segments.length} taxi segments, ${airport.standCount} stands. ${failing.length} of ${airport.outcomes.length} clearances failed a rule.`,
    metrics: [...rules].map(([label, value]) => ({ label, value: String(value) })),
    figures: `<div class="pair">${failing
      .slice(0, MAPS_PER_AIRPORT)
      .map((o) => figure(airport.segments, o))
      .join('')}</div>`
  }
}

/**
 * @param airports Every airport checked.
 * @param seed The seed the clearances were made from.
 * @returns The report.
 */
export function airportsReport(airports: AirportOutcome[], seed: number): Report {
  const total = airports.reduce((sum, a) => sum + a.outcomes.length, 0)
  const failed = airports.reduce((sum, a) => sum + failedCount(a), 0)
  const bad = airports.filter((a) => failedCount(a) > 0).sort((a, b) => failedCount(b) - failedCount(a))
  return {
    title: 'Taxi routes at every cached airport',
    intro: `Clearances made from random walks through each airport's cached taxi network (seed ${seed}), traced with the app's own code and checked against the rules. Airports not yet cached are not covered.`,
    lookFor: [
      'A yellow line that leaves the dashed blue walk the clearance was made from: a zigzag, a detour, or a wrong turn.',
      'A line that stops short of a hold short, or runs past it.',
      'Whether a failure is the trace being wrong, or the walk being an odd route no controller would give.'
    ],
    key: [
      { colour: TAXI_LINE_COLOUR, label: 'The traced route' },
      { colour: TRACK_COLOUR, label: 'The walk the clearance was made from' }
    ],
    summary: [
      { label: 'Airports', value: String(airports.length) },
      { label: 'Clearances', value: String(total) },
      { label: 'Failed a rule', value: String(failed) },
      {
        label: 'Airports with a failure',
        value: `${bad.length}${bad.length > MAX_SECTIONS ? ` (worst ${MAX_SECTIONS} shown)` : ''}`
      }
    ],
    sections: bad.slice(0, MAX_SECTIONS).map(section)
  }
}
