/**
 * The report page for `npm run sim -- flight`: the flight's profile with its phases and ATC
 * silences, the landing measured two ways, the ATC burst and what the app showed through it, and
 * the rules (winglog-backend docs/plans/robustness/scenario-testing.md Part 6).
 */
import type { Sample } from '../scenarios/harness'
import {
  approachProfile,
  meanCrossM,
  type ApproachPoint,
  type PhaseSpan,
  type RunwayLine,
  type Silence,
  type TrackSample
} from './flight'
import type { Report, ReportSection } from './report'
import { TRACK_COLOUR, STEP_COLOURS, escapeHtml } from './svg'

export interface FlightFindings {
  scenario: string
  aircraft: string
  depIcao: string
  arrIcao: string
  capturedAt: string
  durationMs: number
  track: (TrackSample & { altitudeFt: number; groundSpeedKt: number })[]
  touchdownMs: number
  spans: PhaseSpan[]
  silences: Silence[]
  atcLines: { tOffsetMs: number; text: string }[]
  samples: Sample[]
  landing: {
    runway: string | null
    offsetM: number | null
    distanceM: number | null
    verticalSpeedMs: number
    touchdownAtMs: number
  } | null
  simLine: RunwayLine | null
  databaseLine: RunwayLine | null
  measured: { distanceFromThresholdM: number; centrelineOffsetM: number } | null
  replayPhases: string[]
  livePhases: string[]
  /** When BeyondATC reported no station tuned, after the first minute: ms into the capture. */
  nothingTunedAtMs: number[]
  rules: { name: string; broken: string[] }[]
  /** Real-app screenshots from `npm run sim:screens`, found beside the report; empty when there are none. */
  screens: string[]
}

const SIM_COLOUR = TRACK_COLOUR
const DATABASE_COLOUR = STEP_COLOURS[0]

const n1 = (value: number): string => value.toFixed(1)

/** "38.3 m right of the centreline", "1.9 m left". */
function side(offsetM: number | null): string {
  if (offsetM === null) return 'unknown'
  return `${n1(Math.abs(offsetM))} m ${offsetM >= 0 ? 'right' : 'left'}`
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`
}

function hhmm(ms: number): string {
  const total = Math.round(ms / 60_000)
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}`
}

/** Phase band fills alternate, so neighbours are told apart; the label carries the identity. */
const BAND_FILLS = ['var(--net)', 'var(--map)']

/** The flight against time: altitude, the phase band, the ATC lines and the silent stretches. */
function profileFigure(f: FlightFindings): string {
  const W = 780
  const H = 250
  const left = 46
  const right = 10
  const top = 14
  const altBottom = 150
  const x = (ms: number): number => left + (ms / f.durationMs) * (W - left - right)
  const maxAlt = Math.max(10_000, ...f.track.map((t) => t.altitudeFt))
  const yAlt = (ft: number): number => altBottom - (ft / maxAlt) * (altBottom - top)
  const step = Math.max(1, Math.floor(f.track.length / 600))
  const points = f.track
    .filter((_, i) => i % step === 0)
    .map((t) => `${n1(x(t.tOffsetMs))},${n1(yAlt(Math.max(0, t.altitudeFt)))}`)
    .join(' ')

  const silences = f.silences
    .map(
      (s) =>
        `<rect x="${n1(x(s.fromMs))}" y="${top}" width="${n1(x(s.toMs) - x(s.fromMs))}" height="${altBottom - top}" fill="var(--accent)" opacity="0.14"/>` +
        (x(s.toMs) - x(s.fromMs) > 70
          ? `<text x="${n1((x(s.fromMs) + x(s.toMs)) / 2)}" y="${top + 12}" text-anchor="middle" font-size="12" fill="var(--fg)">ATC silent ${minutes(s.toMs - s.fromMs)}</text>`
          : '')
    )
    .join('')

  const bandY = altBottom + 14
  const band = f.spans
    .map((s, i) => {
      const x0 = x(s.fromMs)
      const w = Math.max(1, x(s.toMs) - x0)
      const label =
        w > 46
          ? `<text x="${n1(x0 + w / 2)}" y="${bandY + 17}" text-anchor="middle" font-size="11" fill="var(--fg)">${escapeHtml(s.phase)}</text>`
          : ''
      return `<rect x="${n1(x0)}" y="${bandY}" width="${n1(w)}" height="24" fill="${BAND_FILLS[i % 2]}" stroke="var(--bg)" stroke-width="2"/>${label}`
    })
    .join('')

  const ticks = f.atcLines
    .map(
      (l) =>
        `<line x1="${n1(x(l.tOffsetMs))}" x2="${n1(x(l.tOffsetMs))}" y1="${bandY + 34}" y2="${bandY + 50}" stroke="var(--fg)" stroke-width="1.5"/>`
    )
    .join('')

  const hours: string[] = []
  for (let h = 0; h * 3_600_000 <= f.durationMs; h += 2) {
    const gx = x(h * 3_600_000)
    hours.push(
      `<line x1="${n1(gx)}" x2="${n1(gx)}" y1="${top}" y2="${altBottom}" stroke="var(--net)" stroke-width="0.5"/><text x="${n1(gx)}" y="${bandY + 68}" text-anchor="middle" font-size="11" fill="var(--muted)">${h} h</text>`
    )
  }
  const alts = [0, Math.round(maxAlt / 2 / 1000) * 1000, Math.round(maxAlt / 1000) * 1000]
    .map(
      (ft) =>
        `<text x="${left - 6}" y="${n1(yAlt(ft) + 4)}" text-anchor="end" font-size="11" fill="var(--muted)">${ft === 0 ? '0' : `${ft / 1000}k ft`}</text>`
    )
    .join('')
  const td = x(f.touchdownMs)
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Altitude against time, with phases, ATC lines and silent stretches" style="background:var(--map);border-radius:8px">` +
    hours.join('') +
    silences +
    `<polyline points="${points}" fill="none" stroke="${SIM_COLOUR}" stroke-width="2" stroke-linejoin="round"/>` +
    alts +
    band +
    ticks +
    `<text x="${left - 6}" y="${bandY + 17}" text-anchor="end" font-size="11" fill="var(--muted)">phase</text>` +
    `<text x="${left - 6}" y="${bandY + 46}" text-anchor="end" font-size="11" fill="var(--muted)">ATC</text>` +
    `<line x1="${n1(td)}" x2="${n1(td)}" y1="${top}" y2="${bandY + 52}" stroke="${DATABASE_COLOUR}" stroke-width="1.5" stroke-dasharray="4 3"/>` +
    `<text x="${n1(td - 4)}" y="${top + 26}" text-anchor="end" font-size="12" fill="var(--fg)">touchdown</text>` +
    `</svg>`
  )
}

/** The approach's offset from the centreline, measured against each runway source. */
function crossTrackFigure(f: FlightFindings): string {
  if (!f.simLine || !f.databaseLine) return '<p class="note">No runway line to measure against.</p>'
  const beforeS = 70
  const afterS = 30
  const sim = approachProfile(f.track, f.simLine, f.touchdownMs, beforeS, afterS)
  const database = approachProfile(f.track, f.databaseLine, f.touchdownMs, beforeS, afterS)
  const W = 780
  const H = 280
  const left = 52
  const right = 78
  const top = 14
  const bottom = 34
  const yMin = -60
  const yMax = 60
  const x = (s: number): number => left + ((s + beforeS) / (beforeS + afterS)) * (W - left - right)
  const y = (m: number): number => top + ((yMax - m) / (yMax - yMin)) * (H - top - bottom)
  const line = (points: ApproachPoint[], colour: string): string =>
    `<polyline points="${points.map((p) => `${n1(x(p.tS))},${n1(y(Math.max(yMin, Math.min(yMax, p.crossM))))}`).join(' ')}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"/>`
  const half = (f.simLine.widthM ?? 60) / 2
  const ticks = [-60, -30, 0, 30, 60]
    .map(
      (m) =>
        `<line x1="${left}" x2="${W - right}" y1="${n1(y(m))}" y2="${n1(y(m))}" stroke="var(--net)" stroke-width="${m === 0 ? 1.2 : 0.5}"/><text x="${left - 6}" y="${n1(y(m) + 4)}" text-anchor="end" font-size="11" fill="var(--muted)">${m > 0 ? `${m} R` : m < 0 ? `${-m} L` : '0'}</text>`
    )
    .join('')
  const secs = [-60, -40, -20, 0, 20]
    .map(
      (s) =>
        `<text x="${n1(x(s))}" y="${H - 14}" text-anchor="middle" font-size="11" fill="var(--muted)">${s === 0 ? 'touchdown' : `${s} s`}</text>`
    )
    .join('')
  const lastSim = sim[sim.length - 1]
  const lastDb = database[database.length - 1]
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Offset from the centreline over the last 70 seconds, against the sim's runway and the database's" style="background:var(--map);border-radius:8px">` +
    `<rect x="${left}" y="${n1(y(half))}" width="${W - left - right}" height="${n1(y(-half) - y(half))}" fill="var(--net)" opacity="0.35"/>` +
    `<text x="${left + 6}" y="${n1(y(half) + 14)}" font-size="11" fill="var(--muted)">runway surface (${half * 2} m wide)</text>` +
    ticks +
    secs +
    `<line x1="${n1(x(0))}" x2="${n1(x(0))}" y1="${top}" y2="${H - bottom}" stroke="var(--fg)" stroke-width="1" stroke-dasharray="4 3"/>` +
    line(database, DATABASE_COLOUR) +
    line(sim, SIM_COLOUR) +
    (lastSim
      ? `<text x="${W - right + 6}" y="${n1(y(lastSim.crossM) + 4)}" font-size="12" fill="var(--fg)">sim runway</text>`
      : '') +
    (lastDb
      ? `<text x="${W - right + 6}" y="${n1(y(lastDb.crossM) + 4)}" font-size="12" fill="var(--fg)">database</text>`
      : '') +
    `<text x="${left}" y="${top - 2}" font-size="11" fill="var(--muted)">metres off the centreline (right is up)</text>` +
    `</svg>`
  )
}

function table(head: string[], rows: string[][]): string {
  const th = head
    .map((h) => `<th style="text-align:left;padding:2px 10px 2px 0">${escapeHtml(h)}</th>`)
    .join('')
  const body = rows
    .map(
      (r) =>
        `<tr>${r.map((c) => `<td style="padding:2px 10px 2px 0;vertical-align:top">${escapeHtml(c)}</td>`).join('')}</tr>`
    )
    .join('')
  return `<table style="border-collapse:collapse;font-size:13px"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`
}

/** What the arrival card showed just after each ATC line of the descent burst. */
function burstTable(f: FlightFindings): string {
  const last = [...f.silences].filter((s) => s.toMs <= f.touchdownMs).pop()
  if (!last) return '<p class="note">No long ATC silence before the landing.</p>'
  const rows = f.atcLines
    .filter((l) => l.tOffsetMs >= last.toMs - 1000 && l.tOffsetMs <= f.touchdownMs)
    .slice(0, 16)
    .map((l) => {
      const after = f.samples.find((s) => s.tOffsetMs >= l.tOffsetMs + 10_000)
      const boxes = after?.infoBoxes.map((b) => `${b.title}: ${b.info}`).join('; ') ?? ''
      const card = after?.arrival
        ? `${after.arrival.approachIdent ?? 'arrival'} / ${after.arrival.runway ?? 'no runway'}`
        : 'none'
      return [`${n1((l.tOffsetMs - f.touchdownMs) / 60_000)} min`, l.text, boxes || 'none', card]
    })
  return table(['From touchdown', 'ATC said', 'Boxes 10 s later', 'Arrival card'], rows)
}

/** What each real-app screenshot shows, by its file name (e2e/flight-sim.shots.ts). */
const SCREEN_CAPTIONS: Record<string, string> = {
  '1-before-tracking.png': 'The BeyondATC tab before tracking starts.',
  '2-star-cleared.png':
    'After the STAR clearance (TEBU1B, runway 20R): the app offers an approach, ILS 20R, before ATC has named one.',
  '3-approach-cleared.png':
    'After ATC clears the R-NAV approach with the BIPOP transition: the offer is now RNAV 20R.',
  '3b-after-update.png': 'After choosing Update.',
  '4-track-on-approach.png':
    'The Track tab on the approach. The recording starts mid-flight, and the phase machine picks up the phase the flight is in.'
}

/** The screenshots as one section, or nothing without any. */
function screensSection(f: FlightFindings): ReportSection[] {
  if (f.screens.length === 0) return []
  return [
    {
      title: 'The real app, at each decision',
      meta: 'The built app replaying the last 36 minutes into WSSS (BeyondATC stream and telemetry), 55 times faster. `npm run sim:screens`.',
      metrics: [],
      figures: f.screens
        .map(
          (file) =>
            `<figure><img src="screens/${escapeHtml(file)}" alt="${escapeHtml(SCREEN_CAPTIONS[file] ?? file)}" style="width:100%;border-radius:8px"><figcaption>${escapeHtml(SCREEN_CAPTIONS[file] ?? file)}</figcaption></figure>`
        )
        .join('')
    }
  ]
}

/**
 * The page.
 *
 * @param f What the simulation found.
 * @returns The report.
 */
export function flightReport(f: FlightFindings): Report {
  const failed = f.rules.filter((r) => r.broken.length > 0)
  const sim = f.simLine ? approachProfile(f.track, f.simLine, f.touchdownMs, 70, 30) : []
  const database = f.databaseLine ? approachProfile(f.track, f.databaseLine, f.touchdownMs, 70, 30) : []
  const sections: ReportSection[] = [
    {
      title: 'The flight',
      meta: `${f.aircraft}, ${f.depIcao} to ${f.arrIcao}, ${hhmm(f.durationMs)} recorded. Replayed through the real tracking, BeyondATC and arrival-card code.`,
      metrics: [
        { label: 'Phases (replay)', value: f.replayPhases.join(' > ') },
        { label: 'Phases (live app)', value: f.livePhases.join(' > ') || 'not recorded' }
      ],
      figures: profileFigure(f)
    },
    {
      title: 'The landing, measured two ways',
      meta: f.landing
        ? `Runway ${f.landing.runway ?? 'unresolved'} at ${f.arrIcao}. Same track, two runway lines.`
        : 'No landing was recorded.',
      metrics: f.landing
        ? [
            {
              label: 'Centreline offset, sim runway',
              value: f.measured ? side(f.measured.centrelineOffsetM) : 'not cached',
              was: side(f.landing.offsetM)
            },
            {
              label: 'Distance past the threshold, sim runway',
              value: f.measured ? `${Math.round(f.measured.distanceFromThresholdM)} m` : 'not cached',
              was: f.landing.distanceM === null ? 'unknown' : `${Math.round(f.landing.distanceM)} m`
            },
            {
              label: 'Average offset, last 40 s before touchdown, sim runway',
              value: side(meanCrossM(sim, -40, 0))
            },
            {
              label: 'Average offset, same 40 s, database runway',
              value: side(meanCrossM(database, -40, 0))
            },
            {
              label: 'Vertical speed (from the 1 Hz ticks, not the high-rate stream)',
              value: `${Math.round(f.landing.verticalSpeedMs * 196.85)} fpm`
            }
          ]
        : [],
      figures: crossTrackFigure(f)
    },
    {
      title: 'ATC silence and the last burst before landing',
      meta:
        (f.nothingTunedAtMs.length > 0
          ? `BeyondATC reported "Nothing Tuned" at ${f.nothingTunedAtMs.map((t) => `${n1((t - f.touchdownMs) / 60_000)} min`).join(', ')} from touchdown. `
          : '') +
        (f.silences.length === 0
          ? 'No ATC silence of 30 minutes or more.'
          : `${f.silences.length} silence(s) of 30 minutes or more: ${f.silences.map((s) => `${minutes(s.toMs - s.fromMs)} ending ${n1((s.toMs - f.touchdownMs) / 60_000)} min from touchdown`).join('; ')}.`),
      metrics: f.silences.map((s) => ({
        label: `Lines in the 5 minutes after the silence ending ${n1((s.toMs - f.touchdownMs) / 60_000)} min from touchdown`,
        value: String(s.burstLines)
      })),
      figures: burstTable(f)
    },
    {
      title: 'Rules',
      meta: 'Each rule is checked on the replay of the real recording. A fail names the moment.',
      metrics: f.rules.map((r) => ({
        label: r.name,
        value: r.broken.length === 0 ? '✓ pass' : `✗ ${r.broken.join(' | ')}`
      })),
      figures: ''
    }
  ]
  return {
    title: `Flight simulation: ${f.scenario}`,
    intro: `Captured ${f.capturedAt} by the dev build. Replayed offline through the app's own code; nothing here ran in the sim.`,
    lookFor: [
      'The landing chart: the sim-runway line stays inside the grey runway band, near zero; the database line sits about 40 m to one side for the whole approach. That constant gap is the runway data, not the flying.',
      'The profile: the phase band should read like the flight you flew, and the shaded stretch is where BeyondATC said nothing.',
      'The burst table: after the silence, each clearance should reach the boxes and the arrival card within a moment of being said.'
    ],
    key: [
      { colour: SIM_COLOUR, label: "Measured against the sim's own runway" },
      { colour: DATABASE_COLOUR, label: "Measured against the database's runway (what the app does today)" }
    ],
    summary: [
      { label: 'Rules passed', value: `${f.rules.length - failed.length} of ${f.rules.length}` },
      ...failed.map((r) => ({ label: 'Failed', value: r.name }))
    ],
    sections: [...sections, ...screensSection(f)]
  }
}
