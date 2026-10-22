/**
 * `npm run sim -- taxi-score`: scores the taxi line against every recorded taxi as it was driven, for winglog-backend's
 * docs/plans/taxi-routing-rules.md. The taxis Callum drove as cleared (taxi-evidence.ts's "followed") are the ground truth: their
 * line should lie on the track and the track on the line. The others are shown for checking by eye.
 *
 * Writes release/sim/taxi-score/index.html and results.json (gitignored). TAXI_SCORE_BASELINE=1 also saves the results as the
 * baseline the next runs compare with; TAXI_SCORE_ONLY=253-in,250-in limits the run to those taxis.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { listCachedRunways, listCachedStands, listCachedTaxiSegments } from '../../src/main/db/navdata-repo'
import type { NavdataTaxiSegment } from '../../src/shared/ipc'
import { toLocalXy } from '../../src/shared/geo'
import { traceWithFallback } from '../../src/renderer/src/taxi-fallback'
import { openUserDb } from './local-data'
import { simOutputDir, writeReport, type ReportSection } from './report'
import {
  boundsAround,
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
import { runTaxi, type TaxiScenario } from './taxi'
import { loadFlownNetwork, loadTaxiScenarios, movingSamples, verdictOf, type Verdict } from './taxi-evidence'

/** A point of the line this near the track (or of the track this near the line) is on it. */
const ON_M = 25
/** The line is checked every this many metres. */
const STEP_M = 5

type Xy = [number, number]

interface Score {
  id: string
  icao: string
  verdict: Verdict
  clearance: string
  kind: 'exact' | 'pathfinder' | 'none'
  /** Share of the line's length within ON_M of the track, 0-100. */
  lineOnTrackPct: number | null
  /** Share of the track, up to where it comes nearest the line's end, within ON_M of the line, 0-100. */
  trackOnLinePct: number | null
  /** How near the track comes to the line's end, in metres. */
  endGapM: number | null
  lengthM: number | null
  /** Whether the line passes the same place twice (a lap or a dip in and out). */
  revisits: boolean | null
  /** The line itself, so a later run can draw it as the line before. */
  line: LonLat[] | null
}

const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((100 * part) / whole) : 0)

function distToPolyline(p: Xy, line: Xy[]): number {
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1]
    const [bx, by] = line[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2))
    best = Math.min(best, Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]))
  }
  return line.length === 1 ? Math.hypot(line[0][0] - p[0], line[0][1] - p[1]) : best
}

/** Points along a line every STEP_M, each with the length it stands for. */
function along(line: Xy[]): { p: Xy; m: number; at: number }[] {
  const out: { p: Xy; m: number; at: number }[] = []
  let at = 0
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1]
    const [bx, by] = line[i]
    const len = Math.hypot(bx - ax, by - ay)
    const steps = Math.max(1, Math.ceil(len / STEP_M))
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps
      out.push({ p: [ax + t * (bx - ax), ay + t * (by - ay)], m: len / steps, at: at + t * len })
    }
    at += len
  }
  return out
}

/** Whether a line comes back within 15 m of a place it passed at least 150 m earlier, going the other way or across. */
function revisits(line: Xy[]): boolean {
  const pts = along(line)
  for (let i = 0; i < pts.length; i++)
    for (let k = i + 1; k < pts.length; k++) {
      if (pts[k].at - pts[i].at < 150) continue
      if (Math.hypot(pts[k].p[0] - pts[i].p[0], pts[k].p[1] - pts[i].p[1]) < 15) return true
    }
  return false
}

function score(sc: TaxiScenario, line: LonLat[] | null, kind: Score['kind'], verdict: Verdict): Score {
  const clearance =
    sc.boxes.map((b) => b.info).join(' ') + (sc.holdShortRunway ? `, hold short ${sc.holdShortRunway}` : '')
  const base = { id: sc.id, icao: sc.icao, verdict, clearance, kind, line }
  const moving = movingSamples(sc.samples)
  if (!line || line.length < 2 || moving.length < 2)
    return {
      ...base,
      lineOnTrackPct: null,
      trackOnLinePct: null,
      endGapM: null,
      lengthM: null,
      revisits: null
    }
  const ref = sc.samples[0].lat
  const xy = ([lon, lat]: LonLat): Xy => {
    const { x, y } = toLocalXy({ lat, lon }, ref)
    return [x, y]
  }
  const lineXy = line.map(xy)
  const trackXy = moving.map((s) => xy([s.lon, s.lat]))
  const end = lineXy.at(-1) as Xy
  let nearest = 0
  trackXy.forEach((p, i) => {
    if (
      Math.hypot(p[0] - end[0], p[1] - end[1]) <
      Math.hypot(trackXy[nearest][0] - end[0], trackXy[nearest][1] - end[1])
    )
      nearest = i
  })
  const trackPart = trackXy.slice(0, nearest + 1)
  const linePts = along(lineXy)
  const lengthM = linePts.reduce((a, p) => a + p.m, 0)
  const onTrack = linePts.filter((p) => distToPolyline(p.p, trackXy) <= ON_M).reduce((a, p) => a + p.m, 0)
  const trackPts = trackPart.length > 1 ? along(trackPart) : []
  const trackLen = trackPts.reduce((a, p) => a + p.m, 0)
  const onLine = trackPts.filter((p) => distToPolyline(p.p, lineXy) <= ON_M).reduce((a, p) => a + p.m, 0)
  return {
    ...base,
    lineOnTrackPct: pct(onTrack, lengthM),
    trackOnLinePct: trackLen > 0 ? pct(onLine, trackLen) : null,
    endGapM: Math.round(Math.hypot(trackXy[nearest][0] - end[0], trackXy[nearest][1] - end[1])),
    lengthM: Math.round(lengthM),
    revisits: revisits(lineXy)
  }
}

/** The before line, dashed under today's. */
const BEFORE_COLOUR = '#e03131'

function map(
  sc: TaxiScenario,
  lines: { line: LonLat[] | null; before: LonLat[] | null },
  segments: NavdataTaxiSegment[],
  width = 780
): string {
  const { line, before } = lines
  const track: LonLat[] = movingSamples(sc.samples).map((s) => [s.lon, s.lat])
  const all = [...track, ...(line ?? []), ...(before ?? [])]
  if (all.length === 0) return ''
  // TAXI_SCORE_ZOOM=lat,lon,halfM zooms the large maps in on one place.
  const zoom = width > 780 ? process.env.TAXI_SCORE_ZOOM?.split(',').map(Number) : undefined
  const bounds =
    zoom?.length === 3 ? boundsAround({ lat: zoom[0], lon: zoom[1] }, zoom[2]) : boundsOf(all, 0.0012)
  const frame = makeFrame(bounds, width, width / 3, width * 1.15)
  const parts = [networkLines(frame, segments)]
  if (before)
    parts.push(polyline(frame, before, `stroke="${BEFORE_COLOUR}" stroke-width="3" stroke-dasharray="8 6"`))
  if (line)
    parts.push(polyline(frame, line, `stroke="${TAXI_LINE_COLOUR}" stroke-width="7" stroke-opacity="0.6"`))
  parts.push(polyline(frame, track, `stroke="${TRACK_COLOUR}" stroke-width="2"`))
  if (track[0])
    parts.push(
      `<circle cx="${frame.x(track[0][0]).toFixed(1)}" cy="${frame.y(track[0][1]).toFixed(1)}" r="5" fill="${TRACK_COLOUR}"/>`
    )
  parts.push(networkLabels(frame, segments, zoom ? 13 : 11, zoom !== undefined))
  if (zoom)
    for (const s of segments)
      for (const [lat, lon, hold] of [
        [s.startLat, s.startLon, s.startHoldShort],
        [s.endLat, s.endLon, s.endHoldShort]
      ] as const)
        if (hold)
          parts.push(
            `<circle cx="${frame.x(lon).toFixed(1)}" cy="${frame.y(lat).toFixed(1)}" r="5" fill="#e03131"/>`
          )
  return svg(frame, parts.join(''), `${sc.id} map`)
}

const show = (v: number | boolean | null, unit = ''): string =>
  v === null ? 'n/a' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : `${v}${unit}`

function section(sc: TaxiScenario, s: Score, was: Score | undefined, figure: string): ReportSection {
  const metric = (label: string, key: keyof Score, unit = '') => ({
    label,
    value: show(s[key] as number | boolean | null, unit),
    was: was && was[key] !== s[key] ? show(was[key] as number | boolean | null, unit) : undefined
  })
  return {
    title: `${sc.id} ${sc.icao} (${s.verdict})`,
    meta: `cleared ${s.clearance} · line ${s.kind}`,
    metrics: [
      metric('Line on your track', 'lineOnTrackPct', '%'),
      metric('Your track on the line', 'trackOnLinePct', '%'),
      metric('End to your track', 'endGapM', ' m'),
      metric('Length', 'lengthM', ' m'),
      metric('Passes a place twice', 'revisits')
    ],
    figures: figure
  }
}

it('scores the taxi line against the taxis as driven', () => {
  const { db, close } = openUserDb()
  try {
    const only = process.env.TAXI_SCORE_ONLY?.split(',')
    const dir = simOutputDir('taxi-score')
    const baselinePath = join(dir, 'baseline.json')
    const baseline = existsSync(baselinePath)
      ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Score[])
      : []
    const outcomes = loadTaxiScenarios(db)
      .filter((sc) => !only || only.includes(sc.id))
      .map((sc) => {
        const segments = listCachedTaxiSegments(db, sc.icao)
        const run = runTaxi(
          sc,
          segments,
          listCachedStands(db, sc.icao),
          false,
          listCachedRunways(db, sc.icao)
        )
        const traced = run.request ? traceWithFallback(run.request) : null
        const { verdict } = verdictOf(sc, loadFlownNetwork(sc.icao))
        const s = score(sc, run.cleared, traced?.kind ?? 'none', verdict)
        const lines = { line: run.cleared, before: baseline.find((b) => b.id === sc.id)?.line ?? null }
        // Each map on its own large page too, for looking at one taxi closely.
        mkdirSync(join(dir, 'maps'), { recursive: true })
        writeFileSync(
          join(dir, 'maps', `${sc.id}.html`),
          `<!doctype html><meta charset="utf-8"><style>:root{--fg:#1c1917;--map:#ecebe8;--net:#a8a29e}body{margin:0;background:var(--map)}</style>${map(sc, lines, segments, 1600)}`
        )
        return { sc, s, figure: map(sc, lines, segments) }
      })
    const results = outcomes.map((o) => o.s)
    const followed = results.filter((r) => r.verdict === 'followed' && r.lineOnTrackPct !== null)
    const mean = (xs: number[]): string =>
      xs.length ? `${Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)}%` : 'n/a'
    const page = writeReport(
      'taxi-score',
      {
        title: 'Taxi Line Score',
        intro:
          'Each recorded taxi, its clearance traced by the app’s taxi line code on WingLog’s cached network, against the track you drove. Taxis marked "followed" were driven as cleared, so the line should lie on your track all the way.',
        lookFor: [
          'On followed taxis, the yellow line lies on your blue track from start to end.',
          'No line laps a roundabout or dips into one and out again.',
          'The line ends where the clearance does: the holding point, the runway hold short or the stand.'
        ],
        key: [
          { colour: TAXI_LINE_COLOUR, label: 'taxi line' },
          { colour: BEFORE_COLOUR, label: 'the line before (dashed), where it differs' },
          { colour: TRACK_COLOUR, label: 'your track (dot: clearance received)' }
        ],
        summary: [
          { label: 'Taxis', value: String(results.length) },
          { label: 'Followed as cleared', value: String(followed.length) },
          {
            label: 'Followed: line on your track',
            value: mean(followed.map((r) => r.lineOnTrackPct as number))
          },
          { label: 'Followed: track on the line', value: mean(followed.map((r) => r.trackOnLinePct ?? 0)) },
          { label: 'Lines that pass a place twice', value: String(results.filter((r) => r.revisits).length) }
        ],
        sections: outcomes.map(({ sc, s, figure }) =>
          section(
            sc,
            s,
            baseline.find((b) => b.id === s.id),
            figure
          )
        )
      },
      results
    )
    if (process.env.TAXI_SCORE_BASELINE) writeFileSync(baselinePath, JSON.stringify(results, null, 2))
    for (const r of results) {
      const b = baseline.find((x) => x.id === r.id)
      const cell = (k: 'lineOnTrackPct' | 'trackOnLinePct' | 'endGapM' | 'revisits', width: number): string =>
        `${show(r[k])}${b && b[k] !== r[k] ? `(${show(b[k])})` : ''}`.padEnd(width)
      process.stdout.write(
        `SCORE ${r.id.padEnd(10)} ${r.icao} ${r.verdict.padEnd(9)} ${r.kind.padEnd(10)} line-on-track ${cell('lineOnTrackPct', 9)} track-on-line ${cell('trackOnLinePct', 9)} end-gap ${cell('endGapM', 10)} revisits ${cell('revisits', 8)} len ${show(r.lengthM)}\n`
      )
    }
    process.stdout.write(`Report: ${page}\n`)
  } finally {
    close()
  }
})
