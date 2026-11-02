/**
 * The report page for `npm run sim -- auto-finish`: each recorded arrival from touchdown to the stand, with the ground speed,
 * engine 1 and the parking brake as the sim reported it, and where the flight finished live and with the new rule.
 */
import {
  finalStopMs,
  lastRunStartMs,
  verdictOf,
  type ArrivalFindings,
  type ArrivalTick,
  type Verdict
} from './auto-finish'
import type { Report, ReportSection } from './report'
import { TRACK_COLOUR, escapeHtml } from './svg'

/** Knots per metre per second. */
const KT_PER_MS = 1.943844
/** The speed axis tops out here, in knots, so the taxi-in isn't flattened by the rollout. */
const SPEED_CAP_KT = 40
/** Space before touchdown and after the last event on the figure, ms. */
const MARGIN_MS = 30_000
const ENGINE_COLOUR = '#2f9e44'
const BRAKE_COLOUR = '#e8590c'
/** The new rule's finish: apart from the brake's orange and the speed's blue. */
const NEW_FINISH_COLOUR = '#7048e8'

const n1 = (value: number): string => value.toFixed(1)

/**
 * A clock time.
 *
 * @param epochMs The moment.
 * @returns "15:26:12 UTC".
 */
export function clockUtc(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 19)} UTC`
}

/**
 * The stretches where `holds` is true.
 *
 * @param ticks The ticks, in order.
 * @param holds The condition.
 * @returns Each as [its first tick, its last tick], ms into the capture.
 */
export function stretches(ticks: ArrivalTick[], holds: (t: ArrivalTick) => boolean): [number, number][] {
  const out: [number, number][] = []
  let open: [number, number] | null = null
  for (const t of ticks) {
    if (!holds(t)) {
      open = null
    } else if (open) {
      open[1] = t.tOffsetMs
    } else {
      open = [t.tOffsetMs, t.tOffsetMs]
      out.push(open)
    }
  }
  return out
}

/** A vertical marker with its label. */
interface Marker {
  atMs: number
  label: string
  colour: string
  dashed: boolean
}

/**
 * The arrival against time: ground speed, engine 1, the brake as the sim reported it, and the finish markers.
 *
 * @param f The findings.
 * @param markers The vertical lines to draw.
 * @returns An inline SVG.
 */
export function arrivalFigure(f: ArrivalFindings, markers: Marker[]): string {
  const W = 780
  const left = 92
  const right = 12
  const top = 14
  const speedBottom = 104
  const engineY = speedBottom + 14
  const brakeY = engineY + 24
  const labelsY = brakeY + 50
  const H = labelsY + markers.length * 16 + 18
  const fromMs = f.touchdownMs - MARGIN_MS
  const toMs = Math.max(f.endMs, ...markers.map((m) => m.atMs)) + MARGIN_MS
  const x = (ms: number): number => left + ((ms - fromMs) / (toMs - fromMs)) * (W - left - right)
  const ySpeed = (kt: number): number =>
    speedBottom - (Math.min(kt, SPEED_CAP_KT) / SPEED_CAP_KT) * (speedBottom - top)

  const step = Math.max(1, Math.floor(f.ticks.length / 700))
  const points = f.ticks
    .filter((_, i) => i % step === 0)
    .map((t) => `${n1(x(t.tOffsetMs))},${n1(ySpeed(t.groundSpeedMs * KT_PER_MS))}`)
    .join(' ')
  const band = (y: number, colour: string, label: string, holds: (t: ArrivalTick) => boolean): string =>
    `<text x="${left - 6}" y="${y + 12}" text-anchor="end" font-size="11" fill="var(--muted)">${escapeHtml(label)}</text>` +
    stretches(f.ticks, holds)
      .map(
        ([a, b]) =>
          `<rect x="${n1(x(a))}" y="${y}" width="${n1(Math.max(1.5, x(b) - x(a)))}" height="16" rx="2" fill="${colour}"/>`
      )
      .join('')

  const minuteTicks: string[] = []
  const spanMin = (toMs - fromMs) / 60_000
  const every = spanMin > 30 ? 10 : spanMin > 12 ? 5 : 2
  for (let m = 0; f.touchdownMs + m * 60_000 <= toMs; m += every) {
    const gx = x(f.touchdownMs + m * 60_000)
    if (gx > W - right - 24) break // its label would be cut off at the edge
    minuteTicks.push(
      `<line x1="${n1(gx)}" x2="${n1(gx)}" y1="${top}" y2="${brakeY + 16}" stroke="var(--net)" stroke-width="0.5"/>` +
        `<text x="${n1(gx)}" y="${brakeY + 30}" text-anchor="middle" font-size="11" fill="var(--muted)">${m === 0 ? 'touchdown' : `+${m} min`}</text>`
    )
  }

  const lines = markers
    .map((m, i) => {
      const mx = x(m.atMs)
      const ly = labelsY + i * 16
      const dash = m.dashed ? ' stroke-dasharray="5 3"' : ''
      const anchor = mx > W - 220 ? 'end' : 'start'
      const lx = anchor === 'end' ? mx - 4 : mx + 4
      return (
        `<line x1="${n1(mx)}" x2="${n1(mx)}" y1="${top}" y2="${ly - 4}" stroke="${m.colour}" stroke-width="2"${dash}/>` +
        `<text x="${n1(lx)}" y="${ly}" text-anchor="${anchor}" font-size="12" fill="var(--fg)">${escapeHtml(m.label)}</text>`
      )
    })
    .join('')

  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Ground speed, engine 1 and the parking brake from touchdown to the stand, with the finish markers" style="background:var(--map);border-radius:8px">` +
    minuteTicks.join('') +
    `<text x="${left - 6}" y="${n1(ySpeed(SPEED_CAP_KT) + 4)}" text-anchor="end" font-size="11" fill="var(--muted)">${SPEED_CAP_KT} kt</text>` +
    `<text x="${left - 6}" y="${n1(ySpeed(0) + 4)}" text-anchor="end" font-size="11" fill="var(--muted)">0 kt</text>` +
    `<polyline points="${points}" fill="none" stroke="${TRACK_COLOUR}" stroke-width="2" stroke-linejoin="round"/>` +
    band(engineY, ENGINE_COLOUR, 'engine 1', (t) => t.engine1) +
    band(brakeY, BRAKE_COLOUR, 'parking brake', (t) => t.parkingBrakeOn) +
    lines +
    `</svg>`
  )
}

/** How today's finish reads. */
function todayText(f: ArrivalFindings): string {
  if (f.live.kind === 'open') return 'never finished'
  const how = f.live.kind === 'auto' ? 'by itself' : 'by hand'
  return `${how} at ${clockUtc(f.capturedAtMs + f.live.atMs)}`
}

/** How the new rule's finish reads. */
function newText(f: ArrivalFindings, verdict: Verdict): string {
  if (f.replayFinishMs !== null) return `by itself at ${clockUtc(f.capturedAtMs + f.replayFinishMs)}`
  if (f.live.kind === 'auto') return 'by itself on the same tick (the capture stops one tick before it)'
  if (verdict === 'unchanged') return 'nothing finishes it before you did'
  return 'still never finishes'
}

/** One flight's section. */
function section(f: ArrivalFindings): ReportSection {
  const verdict = verdictOf(f)
  const at = (ms: number | null, otherwise: string): string =>
    ms === null ? otherwise : clockUtc(f.capturedAtMs + ms)
  const stop = finalStopMs(f.ticks)
  const markers: Marker[] = []
  if (stop !== null) markers.push({ atMs: stop, label: 'final stop', colour: 'var(--muted)', dashed: false })
  if (f.live.kind !== 'open')
    markers.push({ atMs: f.live.atMs, label: `today: ${todayText(f)}`, colour: 'var(--fg)', dashed: true })
  if (f.replayFinishMs !== null)
    markers.push({
      atMs: f.replayFinishMs,
      label: `new rule: ${newText(f, verdict)}`,
      colour: NEW_FINISH_COLOUR,
      dashed: false
    })
  const last = f.ticks.at(-1)
  return {
    title: `Flight ${f.flightId}: ${f.route}`,
    meta: `${f.aircraft}, captured ${new Date(f.capturedAtMs).toISOString().slice(0, 10)}`,
    metrics: [
      { label: 'Touchdown', value: at(f.touchdownMs, '-') },
      { label: 'Final stop', value: at(stop, 'still moving at the end') },
      {
        label: 'Engine 1 off',
        value: at(
          lastRunStartMs(f.ticks, (t) => !t.engine1),
          'running at the end of the capture'
        )
      },
      {
        label: 'Parking brake at the end, as the sim reported it',
        value: last?.parkingBrakeOn ? 'on' : 'off'
      },
      { label: 'Finish', value: newText(f, verdict), was: todayText(f) }
    ],
    figures: arrivalFigure(f, markers)
  }
}

/**
 * The whole report.
 *
 * @param findings One per replayed arrival.
 * @param skipped The captures left out, and why.
 * @returns The report for writeReport.
 */
export function autoFinishReport(findings: ArrivalFindings[], skipped: string[]): Report {
  const count = (verdict: Verdict): string => String(findings.filter((f) => verdictOf(f) === verdict).length)
  return {
    title: 'Auto-finish: every engine off',
    intro:
      `Every dev-build capture with a landing (${findings.length}), replayed through the real app with the new rule: a flight ` +
      'finishes by itself once it is stopped after landing with every engine off, and the parking brake is not asked. "Today" is ' +
      'what happened live, from the logbook. The captures hold engine 1 only, so a replay finishes when engine 1 stops; with every ' +
      'engine read, it is when the last one stops.' +
      (skipped.length ? ` Left out: ${skipped.join('; ')}.` : ''),
    lookFor: [
      'Flights 253 and 259 (Fenix A320): no orange brake bar at the stand, and the new finish where engine 1 stops.',
      'Every flight that finished by itself before: no new finish inside the capture, which stops one tick before that finish.',
      'No new finish before the final stop, or while engine 1 still runs.'
    ],
    key: [
      { colour: TRACK_COLOUR, label: `ground speed (to ${SPEED_CAP_KT} kt)` },
      { colour: ENGINE_COLOUR, label: 'engine 1 running' },
      { colour: BRAKE_COLOUR, label: 'parking brake, as the sim reported it' },
      { colour: 'var(--fg)', label: 'finish today (dashed)' },
      { colour: NEW_FINISH_COLOUR, label: 'finish with the new rule' }
    ],
    summary: [
      { label: 'Arrivals replayed', value: String(findings.length) },
      { label: 'Now finish by themselves', value: count('finishesByItself') },
      { label: 'Unchanged', value: count('unchanged') },
      { label: 'Finish earlier than today', value: count('earlier') }
    ],
    // The flights that change first, then the rest by flight.
    sections: [...findings]
      .sort(
        (a, b) =>
          Number(verdictOf(b) === 'finishesByItself') - Number(verdictOf(a) === 'finishesByItself') ||
          a.flightId - b.flightId
      )
      .map(section)
  }
}
