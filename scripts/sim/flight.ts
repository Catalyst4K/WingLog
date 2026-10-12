/**
 * Whole-flight simulation: a dev-build capture replayed through the real app, with the landing,
 * the phases and the ATC timeline checked (winglog-backend
 * docs/plans/robustness/scenario-testing.md Parts 1 and 6). The pure pieces are here; flight.sim.ts
 * runs them on this machine's data and flight-report.ts draws the result.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { positionRelativeToRunway } from '../../src/main/airports/landing-maths'
import type { RunwayEnd } from '../../src/main/airports/runway-lookup'
import type { FlightFixtureEvent, ParsedFlightFixture } from '../../src/main/sim/flight-fixture'
import type { FlightPhase, NavdataRunway } from '../../src/shared/ipc'

/** ATC silence at least this long is reported (cruise handoffs are 15 to 25 minutes apart). */
export const LONG_ATC_SILENCE_MS = 30 * 60_000

/**
 * The capture to simulate: WINGLOG_SIM_CAPTURE if set, else the newest `flight-*.ndjson` in the
 * data folder's `captures/`.
 *
 * @param dataDir WingLog's data folder.
 * @param explicit A path or a file name in `captures/`, or undefined.
 * @returns The path.
 * @throws With no capture to use.
 */
export function findCapture(dataDir: string, explicit: string | undefined): string {
  const dir = join(dataDir, 'captures')
  if (explicit) {
    const path = existsSync(explicit) ? explicit : join(dir, explicit)
    if (!existsSync(path)) throw new Error(`Capture not found: ${explicit}`)
    return path
  }
  const newest = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => /^flight-.*\.ndjson$/.test(name))
        .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)[0]
    : undefined
  if (!newest) throw new Error(`No dev-build capture in ${dir}: fly one with the dev build first`)
  return newest.path
}

/** A runway end as the simulation measures against: where its threshold is and which way it points. */
export interface RunwayLine {
  /** Where the line came from: the app's vendored database or the sim's own facility data. */
  source: 'database' | 'sim'
  ident: string
  thresholdLat: number
  thresholdLon: number
  headingTrueDeg: number
  lengthM: number | null
  widthM: number | null
}

/**
 * The sim's runway as a line, from the cached `navdata_runway` rows.
 *
 * @param runways The airport's cached runways.
 * @param ident The runway.
 * @returns The line, or null when it isn't cached.
 */
export function simRunwayLine(runways: NavdataRunway[], ident: string): RunwayLine | null {
  const runway = runways.find((r) => r.ident === ident)
  return runway
    ? {
        source: 'sim',
        ident,
        thresholdLat: runway.thresholdLat,
        thresholdLon: runway.thresholdLon,
        headingTrueDeg: runway.headingTrueDeg,
        lengthM: runway.lengthM,
        widthM: runway.widthM
      }
    : null
}

/**
 * The vendored database's runway as a line. Measured from the physical end, as the app's own
 * landing record is (it subtracts the displaced threshold only for the distance it reports).
 *
 * @param end The runway end from the lookup.
 * @returns The line.
 */
export function databaseRunwayLine(end: RunwayEnd): RunwayLine {
  return {
    source: 'database',
    ident: end.ident,
    thresholdLat: end.lat,
    thresholdLon: end.lon,
    headingTrueDeg: end.headingTrueDeg,
    lengthM: end.lengthM,
    widthM: end.widthM
  }
}

export interface TrackSample {
  tOffsetMs: number
  latitude: number
  longitude: number
  onGround: boolean
}

export interface ApproachPoint {
  /** Seconds from touchdown; negative before. */
  tS: number
  /** Metres along the runway from the line's threshold. */
  alongM: number
  /** Metres off the centreline; positive is right. */
  crossM: number
}

/**
 * The track around touchdown, measured against one runway line.
 *
 * @param track Every telemetry tick, in order.
 * @param line The runway to measure against.
 * @param touchdownMs The touchdown's offset in the capture.
 * @param beforeS How many seconds before touchdown to include.
 * @param afterS How many seconds after.
 * @returns The points, oldest first.
 */
export function approachProfile(
  track: TrackSample[],
  line: RunwayLine,
  touchdownMs: number,
  beforeS: number,
  afterS: number
): ApproachPoint[] {
  return track
    .filter((t) => t.tOffsetMs >= touchdownMs - beforeS * 1000 && t.tOffsetMs <= touchdownMs + afterS * 1000)
    .map((t) => {
      const p = positionRelativeToRunway(
        t.latitude,
        t.longitude,
        line.thresholdLat,
        line.thresholdLon,
        line.headingTrueDeg
      )
      return {
        tS: (t.tOffsetMs - touchdownMs) / 1000,
        alongM: p.distanceFromThresholdM,
        crossM: p.centrelineOffsetM
      }
    })
}

/**
 * The mean cross-track offset over a stretch of the approach, a steadier figure than one tick.
 *
 * @param points An approach profile.
 * @param fromS Start, seconds from touchdown.
 * @param toS End, seconds from touchdown.
 * @returns Metres, or null with no points in range.
 */
export function meanCrossM(points: ApproachPoint[], fromS: number, toS: number): number | null {
  const inRange = points.filter((p) => p.tS >= fromS && p.tS <= toS)
  return inRange.length === 0 ? null : inRange.reduce((sum, p) => sum + p.crossM, 0) / inRange.length
}

export interface Silence {
  fromMs: number
  toMs: number
  /** ATC lines in the five minutes after the silence ended. */
  burstLines: number
}

/**
 * Stretches with no spoken ATC line, from the capture's incoming BeyondATC messages. A clearance
 * arrives as an `ATC:` line; the other message types keep flowing when ATC goes quiet.
 *
 * @param events The capture's events.
 * @param minGapMs The shortest silence to report.
 * @returns The silences, oldest first.
 */
export function atcSilences(events: FlightFixtureEvent[], minGapMs: number): Silence[] {
  const lines = events
    .filter((e) => e.type === 'beyondatc' && e.direction === 'in' && e.text.startsWith('ATC: '))
    .map((e) => e.tOffsetMs)
  const out: Silence[] = []
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] - lines[i - 1] < minGapMs) continue
    out.push({
      fromMs: lines[i - 1],
      toMs: lines[i],
      burstLines: lines.filter((t) => t >= lines[i] && t < lines[i] + 5 * 60_000).length
    })
  }
  return out
}

/**
 * The distinct phases in order, repeats collapsed.
 *
 * @param phases A phase per sample.
 * @returns The sequence.
 */
export function phaseSequence(phases: (FlightPhase | null)[]): FlightPhase[] {
  const out: FlightPhase[] = []
  for (const phase of phases) if (phase !== null && out[out.length - 1] !== phase) out.push(phase)
  return out
}

export interface PhaseSpan {
  phase: FlightPhase
  fromMs: number
  toMs: number
}

/**
 * Phase spans along the capture's clock.
 *
 * @param samples One entry per tick: its offset and phase.
 * @returns The spans, oldest first.
 */
export function phaseSpans(samples: { tOffsetMs: number; phase: FlightPhase | null }[]): PhaseSpan[] {
  const spans: PhaseSpan[] = []
  for (const s of samples) {
    if (s.phase === null) continue
    const last = spans[spans.length - 1]
    if (last?.phase === s.phase) last.toMs = s.tOffsetMs
    else spans.push({ phase: s.phase, fromMs: s.tOffsetMs, toMs: s.tOffsetMs })
  }
  return spans
}

/** The capture's telemetry as a track. */
export function trackOf(
  capture: ParsedFlightFixture
): (TrackSample & { altitudeFt: number; groundSpeedKt: number })[] {
  return capture.events.flatMap((e) =>
    e.type === 'telemetry'
      ? [
          {
            tOffsetMs: e.tOffsetMs,
            latitude: e.data.latitude,
            longitude: e.data.longitude,
            onGround: e.data.onGround,
            altitudeFt: e.data.altitudeM / 0.3048,
            groundSpeedKt: e.data.groundSpeedMs / 0.514444
          }
        ]
      : []
  )
}

/**
 * A climb or descent that lasts a moment between two spans of cruise: the phase flickering on a
 * small altitude wobble, not a real change of flight (flight 236, after the top of climb).
 *
 * @param spans The phase spans.
 * @param maxMs The longest blip to report.
 * @returns One line per blip.
 */
export function phaseFlicker(spans: PhaseSpan[], maxMs: number): string[] {
  const out: string[] = []
  for (let i = 1; i < spans.length - 1; i++) {
    const s = spans[i]
    if (s.phase !== 'climb' && s.phase !== 'descent') continue
    if (spans[i - 1].phase !== 'cruise' || spans[i + 1].phase !== 'cruise') continue
    if (s.toMs - s.fromMs > maxMs) continue
    out.push(
      `${s.phase} for ${Math.round((s.toMs - s.fromMs) / 1000)} s between cruise at ${(s.fromMs / 60000).toFixed(1)} min`
    )
  }
  return out
}
