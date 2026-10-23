/**
 * `npm run sim -- taxi-reroute-fuzz`: drives the real taxi line service sample by sample along routes with one deviation each (taxi-fuzz.ts)
 * and checks how the line re-routes (winglog-backend docs/plans/taxi-and-second-screen-robustness.md, stage 6d). A run passes when:
 *
 * - the line is re-routed within MAX_REROUTE_S of the aircraft leaving the route, and the re-routes stay within MAX_REROUTES_PER_MIN a minute;
 * - every line published at a re-route passes `routeProblems`;
 * - the line never points behind the aircraft for more than MAX_BEHIND_S in a row while it moves, and never goes missing once drawn.
 *
 * Writes release/sim/taxi-reroute-fuzz/index.html and results.json (gitignored). Environment: TAXI_FUZZ_N (routes per airport and end type,
 * default 40), TAXI_FUZZ_ONLY (airport codes, comma separated), TAXI_FUZZ_SEED.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it, vi } from 'vitest'
import { openUserDb } from './local-data'
import { simOutputDir, writeReport, type ReportSection } from './report'
import { buildGraph, sampleCases } from './taxi-generate'
import { DEVIATIONS, fuzzDrive } from './taxi-fuzz'
import { FAILURES, MAX_BEHIND_S, MAX_REROUTE_S, runDrive, type RunResult } from './taxi-fuzz-run'
import { loadGeneratorAirports } from './taxi-networks'
import {
  boundsOf,
  makeFrame,
  networkLines,
  polyline,
  svg,
  TAXI_LINE_COLOUR,
  TRACK_COLOUR,
  type LonLat
} from './svg'

vi.mock('../../src/main/logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))
const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const median = (values: number[]): number | undefined =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

it('re-routes the taxi line after each deviation', async () => {
  const { db, close } = openUserDb()
  try {
    const n = Number(process.env.TAXI_FUZZ_N ?? 40)
    const seed = Number(process.env.TAXI_FUZZ_SEED ?? 1)
    const only = process.env.TAXI_FUZZ_ONLY?.split(',')
    const airports = loadGeneratorAirports(db, only)
    const results: RunResult[] = []
    const sections: ReportSection[] = []
    for (const airport of airports) {
      const graph = buildGraph(airport.segments)
      const cases = (['holding-point', 'stand', 'hold-short'] as const).flatMap((e) =>
        sampleCases(airport, e, n, seed)
      )
      for (const deviation of DEVIATIONS) {
        const rows: { result: RunResult; figure: string }[] = []
        for (const c of cases) {
          const drive = fuzzDrive(graph, c.truth, deviation)
          if (!drive) continue
          const { result, lastLine } = await runDrive(airport, `${c.id}/${deviation}`, c.clearance, drive)
          let figure = ''
          if (result.failures.length > 0 && rows.filter((r) => r.figure).length < 3) {
            const track: LonLat[] = drive.samples.map((s) => [s.lon, s.lat])
            const frame = makeFrame(boundsOf([...c.truth, ...track], 0.0025), 380, 200, 380)
            const content =
              networkLines(frame, airport.segments) +
              polyline(
                frame,
                c.truth,
                `fill="none" stroke="${TRACK_COLOUR}" stroke-width="3" stroke-dasharray="6 4"`
              ) +
              polyline(frame, track, 'fill="none" stroke="#e03131" stroke-width="2"') +
              (lastLine
                ? polyline(frame, lastLine, `fill="none" stroke="${TAXI_LINE_COLOUR}" stroke-width="3"`)
                : '')
            figure = `<figure>${svg(frame, content, result.id)}<figcaption>${escape(result.id)}: ${result.failures.join(', ')}</figcaption></figure>`
          }
          rows.push({ result, figure })
        }
        const rs = rows.map((r) => r.result)
        results.push(...rs)
        const failed = rs.filter((r) => r.failures.length > 0)
        const after = rs.map((r) => r.rerouteAfterS).filter((v): v is number => v !== null)
        const slowest = Math.max(0, ...rs.map((r) => r.maxSampleMs))
        const counts = FAILURES.map((f) => `${f} ${rs.filter((r) => r.failures.includes(f)).length}`).join(
          ' '
        )
        process.stdout.write(
          `FUZZ ${airport.icao} ${deviation.padEnd(16)} runs ${String(rs.length).padStart(4)} failed ${String(failed.length).padStart(4)} ${counts} slowest ${slowest} ms\n`
        )
        sections.push({
          title: `${airport.icao}: ${deviation}`,
          meta: `${rs.length} runs`,
          metrics: [
            { label: 'Failed', value: `${failed.length} of ${rs.length}` },
            {
              label: 'Re-route after (s), median / max',
              value: `${median(after) ?? '-'} / ${Math.max(0, ...after) || '-'}`
            },
            { label: 'Slowest sample', value: `${slowest} ms` }
          ],
          notScored: rs.length === 0 ? 'No route here has a place for this deviation.' : undefined,
          figures: `<div class="pair">${rows.map((r) => r.figure).join('')}</div>`
        })
      }
    }
    writeFileSync(join(simOutputDir('taxi-reroute-fuzz'), 'results.json'), JSON.stringify(results))
    const failedAll = results.filter((r) => r.failures.length > 0).length
    const page = writeReport(
      'taxi-reroute-fuzz',
      {
        title: 'Taxi Line Re-routing Under Deviations',
        intro: `Routes sampled on each airport's network, driven at 8 m/s with one deviation each, fed sample by sample to the real taxi line service. A run passes when the line is re-routed within ${MAX_REROUTE_S} s of leaving the route, every re-route is a route an aircraft could taxi, the line does not point behind the aircraft for more than ${MAX_BEHIND_S} s, and it never goes missing once drawn.`,
        lookFor: [
          'Red is the driven track, blue dashed the cleared route, yellow the last line drawn.',
          'A yellow line that ends nowhere near the cleared end, or doubles back on the red track.'
        ],
        key: [
          { colour: TRACK_COLOUR, label: 'the cleared route (dashed)' },
          { colour: '#e03131', label: 'the track driven' },
          { colour: TAXI_LINE_COLOUR, label: 'the last line the app drew' }
        ],
        summary: [
          { label: 'Runs', value: String(results.length) },
          { label: 'Failed', value: String(failedAll) }
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
