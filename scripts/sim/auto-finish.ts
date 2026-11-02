/**
 * Auto-finish simulation: every dev-build capture with a landing replayed through the real app, and when each flight now
 * finishes by itself compared with what happened live (winglog-backend docs/decisions.md 2026-11-02: once it's stopped after
 * landing with every engine off, the parking brake not asked). The pure pieces are here; auto-finish.sim.ts runs them on this
 * machine's data and auto-finish-report.ts draws the result.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ParsedFlightFixture } from '../../src/main/sim/flight-fixture'
import { MOVING_MS } from '../../src/main/tracking/flight-phase-step'
import type { FlightPhase } from '../../src/shared/ipc'

/** One telemetry tick, as the finish rule reads it. Captures before 2026-11-02 hold engine 1 only. */
export interface ArrivalTick {
  tOffsetMs: number
  groundSpeedMs: number
  engine1: boolean
  parkingBrakeOn: boolean
}

/** How the flight finished live, from the logbook, in ms into its capture. */
export type LiveFinish = { kind: 'auto' | 'byHand'; atMs: number } | { kind: 'open' }

/** What the simulation found for one arrival. Times are ms into the capture. */
export interface ArrivalFindings {
  flightId: number
  route: string
  aircraft: string
  /** When the capture started, epoch ms: a clock time is this plus an offset. */
  capturedAtMs: number
  touchdownMs: number
  /** The capture's last tick. */
  endMs: number
  /** From touchdown to the end. */
  ticks: ArrivalTick[]
  live: LiveFinish
  /** When the replay finished the flight, or null when it didn't within the capture. */
  replayFinishMs: number | null
}

/**
 * What the new rule changes for one flight:
 * - `finishesByItself`: it now finishes within the capture, after the final stop, where today it was finished by hand or not at all;
 * - `earlier`: it now finishes before today's finish, or before the aircraft stopped, which the report must never show;
 * - `unchanged`: nothing finishes it inside the capture, so today's finish stands;
 * - `stillOpen`: nothing finishes it, and it never finished live either.
 */
export type Verdict = 'finishesByItself' | 'earlier' | 'unchanged' | 'stillOpen'

/**
 * Every flight capture in the data folder's `captures/` and `captures/kept/`.
 *
 * @param dataDir WingLog's data folder.
 * @returns Their paths, by file name (which starts with the flight id) within each folder.
 */
export function listCaptures(dataDir: string): string[] {
  return ['captures', join('captures', 'kept')].flatMap((sub) => {
    const dir = join(dataDir, sub)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => /^flight-.*\.ndjson$/.test(name))
      .sort()
      .map((name) => join(dir, name))
  })
}

/**
 * The capture's telemetry from `fromMs` on, as the finish rule reads it.
 *
 * @param capture The capture.
 * @param fromMs Where to start, ms into the capture.
 * @returns One tick per telemetry event.
 */
export function arrivalTicks(capture: ParsedFlightFixture, fromMs: number): ArrivalTick[] {
  return capture.events.flatMap((e) =>
    e.type === 'telemetry' && e.tOffsetMs >= fromMs
      ? [
          {
            tOffsetMs: e.tOffsetMs,
            groundSpeedMs: e.data.groundSpeedMs,
            engine1: e.data.engineCombustion1,
            parkingBrakeOn: e.data.parkingBrakeOn
          }
        ]
      : []
  )
}

/**
 * Where the final run of ticks for which `holds` is true began.
 *
 * @param ticks The ticks, in order.
 * @param holds The condition.
 * @returns ms into the capture, or null when the last tick doesn't meet it.
 */
export function lastRunStartMs(ticks: ArrivalTick[], holds: (t: ArrivalTick) => boolean): number | null {
  let start: number | null = null
  for (const t of ticks) start = holds(t) ? (start ?? t.tOffsetMs) : null
  return start
}

/**
 * When the aircraft came to its last stop.
 *
 * @param ticks The ticks, in order.
 * @returns ms into the capture, or null when the capture ends moving.
 */
export function finalStopMs(ticks: ArrivalTick[]): number | null {
  return lastRunStartMs(ticks, (t) => t.groundSpeedMs < MOVING_MS)
}

/**
 * How the flight finished live: by itself when the logbook has a shutdown point, by hand when it completed without one.
 *
 * @param points The flight's track points.
 * @param flight Its status and on-blocks time.
 * @param capturedAtMs When the capture started, epoch ms.
 * @returns The finish, in ms into the capture.
 */
export function liveFinish(
  points: { phase: FlightPhase; tsUtc: string }[],
  flight: { status: string; actualInUtc: string | null },
  capturedAtMs: number
): LiveFinish {
  const shutdown = points.find((p) => p.phase === 'shutdown')
  if (shutdown) return { kind: 'auto', atMs: Date.parse(shutdown.tsUtc) - capturedAtMs }
  if (flight.status === 'completed' && flight.actualInUtc)
    return { kind: 'byHand', atMs: Date.parse(flight.actualInUtc) - capturedAtMs }
  return { kind: 'open' }
}

/**
 * What the new rule changes for one flight (see Verdict).
 *
 * @param f The findings.
 * @returns The verdict.
 */
export function verdictOf(f: ArrivalFindings): Verdict {
  if (f.replayFinishMs === null) return f.live.kind === 'open' ? 'stillOpen' : 'unchanged'
  const stop = finalStopMs(f.ticks)
  if (stop === null || f.replayFinishMs < stop || f.live.kind === 'auto') return 'earlier'
  return 'finishesByItself'
}
