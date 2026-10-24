/**
 * `npm run sim -- taxi-generated`: makes taxi clearances on every airport WingLog has a taxi network for, traces each the way the app does,
 * and scores what it draws against the route the clearance was made from (winglog-backend docs/plans/taxi-and-second-screen-robustness.md,
 * stage 6c). A line "follows" when at least FOLLOW_PCT of it lies on the route and at least FOLLOW_PCT of the route on it, within 25 m: the
 * same measure `taxi-score` applies to the recorded taxis, with the threshold taken from them.
 *
 * Writes release/sim/taxi-generated/index.html and results.json (gitignored). Environment: TAXI_GEN_N (cases per airport and kind, default
 * 500), TAXI_GEN_ONLY (airport codes, comma separated), TAXI_GEN_SEED (changes which cases are sampled).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { greatCircleM } from '../../src/shared/geo'
import { clearanceEnds, traceClearanceDetailed } from '../../src/shared/taxi/clearance'
import type { RouteProblem } from '../../src/shared/taxi/route-checks'
import { flat, shareOnLine } from './taxi-geometry'
import { sampleCases, type EndType, type GeneratedCase, type GeneratorAirport } from './taxi-generate'
import { loadGeneratorAirports } from './taxi-networks'
import { openUserDb } from './local-data'
import { simOutputDir, writeReport, type ReportSection } from './report'
import {
  boundsOf,
  makeFrame,
  networkLabels,
  networkLines,
  polyline,
  svg,
  TAXI_LINE_COLOUR,
  TRACK_COLOUR,
  type LonLat
} from './svg'

const END_TYPES: EndType[] = ['holding-point', 'hold-short', 'stand']

/** How one generated clearance came out. */
export interface CaseResult {
  id: string
  icao: string
  endType: EndType
  pushback: boolean
  linkLimitM: number
  text: string
  kind: 'exact' | 'pathfinder' | 'none'
  /** What is wrong with the line drawn (route-checks.ts). */
  problems: RouteProblem[]
  /** Share of the line within 25 m of the route the clearance was made from, 0-100; null with no line. */
  lineOnRoutePct: number | null
  /** Share of that route within 25 m of the line. */
  routeOnLinePct: number | null
  /** How far the line's end is from the route's, metres. */
  endGapM: number | null
  followed: boolean
  ms: number
}

/**
 * The follow threshold: the lowest score any recorded taxi driven as cleared reaches in taxi-score, rounded down to 5%.
 *
 * @param dir WingLog's sim output folder for taxi-score.
 * @returns The percentage; 80 when taxi-score has not been run here.
 */
function followThreshold(dir: string): number {
  const path = join(dir, 'results.json')
  if (!existsSync(path)) return 80
  const rows = JSON.parse(readFileSync(path, 'utf8')) as {
    verdict: string
    lineOnTrackPct: number | null
    trackOnLinePct: number | null
  }[]
  const scores = rows
    .filter((r) => r.verdict === 'followed' && r.lineOnTrackPct !== null && r.trackOnLinePct !== null)
    .map((r) => Math.min(r.lineOnTrackPct as number, r.trackOnLinePct as number))
  return scores.length > 0 ? Math.floor(Math.min(...scores) / 5) * 5 : 80
}

/**
 * Traces one generated clearance and scores it.
 *
 * @param airport The airport.
 * @param c The case.
 * @param threshold The follow threshold, percent.
 * @returns The result, and the line drawn.
 */
export function runCase(
  airport: GeneratorAirport,
  c: GeneratedCase,
  threshold: number
): { result: CaseResult; line: LonLat[] | null } {
  const ends = clearanceEnds(c.clearance, airport.stands, airport.runways)
  const startedAt = performance.now()
  const traced = traceClearanceDetailed(
    c.clearance,
    airport.segments,
    ends.stand,
    ends.threshold,
    ends.holdShortRunway
  )
  const ms = performance.now() - startedAt
  const base = {
    id: c.id,
    icao: c.icao,
    endType: c.endType,
    pushback: c.pushback,
    linkLimitM: c.linkLimitM,
    text: c.text,
    ms: Math.round(ms * 10) / 10
  }
  if (!traced)
    return {
      line: null,
      result: {
        ...base,
        kind: 'none',
        problems: [],
        lineOnRoutePct: null,
        routeOnLinePct: null,
        endGapM: null,
        followed: false
      }
    }
  const ref = c.truth[0][1]
  const line = flat(traced.route, ref)
  const truth = flat(c.truth, ref)
  const lineOnRoutePct = shareOnLine(line, truth)
  const routeOnLinePct = shareOnLine(truth, line)
  const end = traced.route[traced.route.length - 1]
  const truthEnd = c.truth[c.truth.length - 1]
  return {
    line: traced.route,
    result: {
      ...base,
      kind: traced.kind,
      problems: traced.problems,
      lineOnRoutePct,
      routeOnLinePct,
      endGapM: Math.round(greatCircleM({ lat: end[1], lon: end[0] }, { lat: truthEnd[1], lon: truthEnd[0] })),
      followed: (lineOnRoutePct ?? 0) >= threshold && (routeOnLinePct ?? 0) >= threshold
    }
  }
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0

/**
 * @param c A case.
 * @param line The line the app drew for it, or null.
 * @param airport Its airport.
 * @returns A map of the network with the route it was made from and the line drawn.
 */
function caseFigure(c: GeneratedCase, line: LonLat[] | null, airport: GeneratorAirport): string {
  const frame = makeFrame(boundsOf([...c.truth, ...(line ?? [])], 0.0025), 380, 200, 380)
  const content =
    networkLines(frame, airport.segments) +
    networkLabels(frame, airport.segments, 9) +
    polyline(frame, c.truth, `fill="none" stroke="${TRACK_COLOUR}" stroke-width="3" stroke-dasharray="6 4"`) +
    (line
      ? polyline(frame, line, `fill="none" stroke="${TAXI_LINE_COLOUR}" stroke-width="3" opacity="0.9"`)
      : '')
  return `<figure>${svg(frame, content, c.text)}<figcaption>${escape(c.id)}: ${escape(c.text)}</figcaption></figure>`
}

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

it('scores the taxi line on generated clearances', () => {
  const { db, close } = openUserDb()
  try {
    const n = Number(process.env.TAXI_GEN_N ?? 500)
    const seed = Number(process.env.TAXI_GEN_SEED ?? 1)
    const only = process.env.TAXI_GEN_ONLY?.split(',')
    const dir = simOutputDir('taxi-generated')
    const threshold = followThreshold(simOutputDir('taxi-score'))
    const airports = loadGeneratorAirports(db, only)
    const results: CaseResult[] = []
    const sections: ReportSection[] = []
    for (const airport of airports) {
      for (const endType of END_TYPES) {
        const cases = sampleCases(airport, endType, n, seed)
        const outcomes = cases.map((c) => ({ c, ...runCase(airport, c, threshold) }))
        results.push(...outcomes.map((o) => o.result))
        const rows = outcomes.map((o) => o.result)
        const followed = rows.filter((r) => r.followed).length
        const times = rows.map((r) => r.ms).sort((a, b) => a - b)
        const count = (test: (r: CaseResult) => boolean): number => rows.filter(test).length
        const failing = outcomes.filter((o) => !o.result.followed)
        process.stdout.write(
          `GEN ${airport.icao} ${endType.padEnd(13)} cases ${String(rows.length).padStart(4)} followed ${String(followed).padStart(4)} (${rows.length ? Math.round((100 * followed) / rows.length) : 0}%) pathfinder ${count((r) => r.kind === 'pathfinder')} none ${count((r) => r.kind === 'none')} problems ${count((r) => r.problems.length > 0)} p50 ${percentile(times, 0.5)} ms max ${times.at(-1) ?? 0} ms\n`
        )
        sections.push({
          title: `${airport.icao}: ${endType}`,
          meta: `${airport.segments.length} segments, ${airport.runways.length} runway ends, ${airport.stands.length} stands`,
          metrics: [
            { label: 'Cases', value: String(rows.length) },
            {
              label: 'Followed',
              value: `${followed} (${rows.length ? Math.round((100 * followed) / rows.length) : 0}%)`
            },
            { label: 'Traced', value: String(count((r) => r.kind === 'exact')) },
            { label: 'Shortest way', value: String(count((r) => r.kind === 'pathfinder')) },
            { label: 'No line', value: String(count((r) => r.kind === 'none')) },
            { label: 'Line with a problem', value: String(count((r) => r.problems.length > 0)) },
            {
              label: 'Time p50 / p95 / max',
              value: `${percentile(times, 0.5)} / ${percentile(times, 0.95)} / ${times.at(-1) ?? 0} ms`
            }
          ],
          notScored: rows.length === 0 ? 'This network could not make cases of this kind.' : undefined,
          figures: `<div class="pair">${failing
            .slice(0, 4)
            .map((o) => caseFigure(o.c, o.line, airport))
            .join('')}</div>`
        })
      }
    }
    const followedAll = results.filter((r) => r.followed).length
    writeFileSync(join(dir, 'results.json'), JSON.stringify(results))
    const page = writeReport(
      'taxi-generated',
      {
        title: 'Taxi Line on Generated Clearances',
        intro: `Clearances made from routes sampled on each airport's cached taxi network, traced the way the app traces them, and scored against the route they were made from. Followed means at least ${threshold}% of the line lies on the route and of the route on the line (the lowest the recorded, followed taxis score, rounded down). The four worst of each group are drawn.`,
        lookFor: [
          'Where the yellow line leaves the dashed blue route: is the clearance one a controller would plausibly give?',
          'A line that is missing: no line is drawn when no route is found.',
          'A group with many failures at one airport: a rule that does not hold there.'
        ],
        key: [
          { colour: TRACK_COLOUR, label: 'the route the clearance was made from (dashed)' },
          { colour: TAXI_LINE_COLOUR, label: 'the line the app draws' }
        ],
        summary: [
          { label: 'Cases', value: String(results.length) },
          {
            label: 'Followed',
            value: `${followedAll} (${results.length ? Math.round((100 * followedAll) / results.length) : 0}%)`
          },
          { label: 'Follow threshold', value: `${threshold}%` }
        ],
        sections
      },
      results
    )
    process.stdout.write(`Report: ${page}\n`)
  } finally {
    close()
  }
}, 3_600_000)
