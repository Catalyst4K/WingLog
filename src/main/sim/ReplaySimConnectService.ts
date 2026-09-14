import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { SimConnectionStatus, SimTelemetry } from '@shared/ipc'
import { parseFlightFixture, type FlightFixtureEvent, type FlightFixtureHeader } from './flight-fixture'

interface ReplaySimConnectServiceEvents {
  telemetry: [SimTelemetry]
  status: [SimConnectionStatus]
  paused: [boolean]
  /** Not part of SimConnectService's own contract — fires once every fixture event has
   *  been replayed, so a driving script/test knows when it's safe to inspect the result
   *  instead of guessing at a timeout. */
  replayComplete: []
}

export type ReplayMode = 'instant' | 'paced'

export interface ReplaySimConnectServiceOptions {
  /** 'instant' (default): emit every tick as fast as the event loop allows — for
   *  unit/integration tests that only care about the end state. 'paced': schedule each
   *  tick at its recorded tOffsetMs delta (divided by speedMultiplier), so real wall-clock
   *  time elapses between ticks — needed for a Playwright test that wants to watch Track's
   *  map update live, or for anything that depends on FlightRecorder's own
   *  wall-clock-based downsampling (shouldRecord) behaving like a real live session. See
   *  flightdeck-backend's docs/plans/flight-replay-harness.md Phase 1 notes: only
   *  speedMultiplier 1 (real time) reproduces the original recording's exact downsampled
   *  point density — any other speed changes how much wall-clock time elapses between
   *  ticks and therefore how often shouldRecord's per-phase interval check trips, same as
   *  it would on a real live session flown faster or slower. Phase transitions themselves
   *  are tick-count-based (LEVEL_SUSTAIN_SAMPLES etc.), not time-based, so those replay
   *  identically regardless of mode or speed. */
  mode?: ReplayMode
  /** paced mode only: 1 = real time, 60 = a 69-minute flight replays in ~69 seconds. */
  speedMultiplier?: number
}

/**
 * Replays a captured flight fixture (scripts/spike-capture-flight.ts's NDJSON output)
 * through the same public surface as SimConnectService (extends EventEmitter,
 * start()/stop()/getStatus()/getLastTelemetry(), the same telemetry/status/paused events)
 * so TrackingController can be driven by a recorded flight instead of a live sim — per
 * flightdeck-backend's docs/plans/flight-replay-harness.md Phase 1. TrackingController's
 * constructor is typed to the concrete SimConnectService class (which has private fields,
 * making it nominally — not just structurally — typed), so a caller hands this to it with
 * the same `as unknown as SimConnectService` cast TrackingController.test.ts's ad hoc
 * fakeSimConnectService() already uses; changing that constructor's type is Phase 3's
 * main/index.ts injection-seam work, not this class's job.
 */
export class ReplaySimConnectService extends EventEmitter<ReplaySimConnectServiceEvents> {
  readonly header: FlightFixtureHeader
  private readonly events: FlightFixtureEvent[]
  private readonly mode: ReplayMode
  private readonly speedMultiplier: number
  private status: SimConnectionStatus = { state: 'disconnected' }
  private lastTelemetry: SimTelemetry
  private stopped = true
  private timer: NodeJS.Timeout | undefined

  constructor(fixturePath: string, options: ReplaySimConnectServiceOptions = {}) {
    super()
    this.mode = options.mode ?? 'instant'
    this.speedMultiplier = options.speedMultiplier ?? 1

    const { header, events } = parseFlightFixture(readFileSync(fixturePath, 'utf8'))
    this.header = header
    this.events = events

    // getLastTelemetry() must return the first tick's data immediately on construction —
    // TrackingController.start() depends on this being non-undefined, and per the plan
    // doc's Design §2 a replay double must satisfy that before start() is even called.
    const firstTelemetry = events.find((e) => e.type === 'telemetry')
    if (!firstTelemetry || firstTelemetry.type !== 'telemetry') {
      throw new Error(`Fixture ${fixturePath} has no telemetry events`)
    }
    this.lastTelemetry = firstTelemetry.data
  }

  getStatus(): SimConnectionStatus {
    return this.status
  }

  getLastTelemetry(): SimTelemetry | undefined {
    return this.lastTelemetry
  }

  /** Total telemetry ticks in the fixture (excludes 'paused' events) — for a driving
   *  script/test to report how much of the fixture actually got replayed. */
  get telemetryTickCount(): number {
    return this.events.filter((e) => e.type === 'telemetry').length
  }

  start(): void {
    this.stopped = false
    this.status = { state: 'connected', simConnectVersion: 'replay' }
    this.emit('status', this.status)
    this.playFrom(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.status = { state: 'disconnected' }
  }

  private playFrom(index: number): void {
    if (this.stopped) return
    if (index >= this.events.length) {
      this.stopped = true
      this.emit('replayComplete')
      return
    }

    const emitAndAdvance = (): void => {
      if (this.stopped) return
      const event = this.events[index]
      if (event.type === 'telemetry') {
        this.lastTelemetry = event.data
        this.emit('telemetry', event.data)
      } else {
        this.emit('paused', event.value)
      }
      this.playFrom(index + 1)
    }

    if (this.mode === 'instant') {
      // Still deferred (not a direct call) so listeners run in normal event-loop order
      // rather than one giant synchronous call stack for a multi-thousand-tick fixture.
      setImmediate(emitAndAdvance)
      return
    }

    const previousOffsetMs = index > 0 ? this.events[index - 1].tOffsetMs : 0
    const deltaMs = Math.max(0, this.events[index].tOffsetMs - previousOffsetMs)
    this.timer = setTimeout(emitAndAdvance, deltaMs / this.speedMultiplier)
  }
}
