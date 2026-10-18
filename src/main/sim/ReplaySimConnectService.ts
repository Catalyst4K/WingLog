/**
 * Plays a recorded flight (a capture or fixture) to TrackingController in place of the live sim:
 * the replay harness behind the scenario tests, the e2e tests and the simulations
 * (winglog-backend docs/plans/done/flight-replay-harness.md).
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { SimConnectionStatus, SimTelemetry } from '@shared/ipc'
import type { TouchdownSeverity } from './SimConnectSource'
import {
  parseFlightFixture,
  type CapturedLineEvent,
  type FlightFixtureEvent,
  type FlightFixtureHeader,
  type ParsedFlightFixture
} from './flight-fixture'

interface ReplaySimConnectServiceEvents {
  telemetry: [SimTelemetry]
  status: [SimConnectionStatus]
  paused: [boolean]
  // Declared, never emitted — recorded fixtures are 1 Hz only, with no high-rate data to
  // derive it from. Needed only so this class keeps structurally satisfying SimConnectSource
  // (SimConnectSource.ts), which TrackingController's constructor requires; the touchdown
  // vertical speed simply falls back to previousTelemetry for a replayed flight, same as
  // before this event existed.
  touchdownSeverity: [TouchdownSeverity]
  /** Not part of SimConnectService's own contract — fires once every fixture event has
   *  been replayed, so a driving script/test knows when it's safe to inspect the result
   *  instead of guessing at a timeout. */
  replayComplete: []
  /** A BeyondATC or GSX line from a full capture, at its moment in the replay; replay-capture.ts
   *  hands it to the matching service. */
  captured: [CapturedLineEvent]
  /** Before each event is replayed: its offset from the start of the capture, in ms, so a
   *  driver can keep a clock in step with the recording. */
  offset: [number]
}

export type ReplayMode = 'instant' | 'paced'

export interface ReplaySimConnectServiceOptions {
  /** 'instant' (default): emit every tick as fast as the event loop allows — for
   *  unit/integration tests that only care about the end state. 'paced': schedule each
   *  tick at its recorded tOffsetMs delta (divided by speedMultiplier), so real wall-clock
   *  time elapses between ticks — needed for a Playwright test that wants to watch Track's
   *  map update live, or for anything that depends on FlightRecorder's own
   *  wall-clock-based downsampling (shouldRecord) behaving like a real live session. See
   *  winglog-backend's docs/plans/flight-replay-harness.md Phase 1 notes: only
   *  speedMultiplier 1 (real time) reproduces the original recording's exact downsampled
   *  point density — any other speed changes how much wall-clock time elapses between
   *  ticks and therefore how often shouldRecord's per-phase interval check trips, same as
   *  it would on a real live session flown faster or slower. Phase transitions themselves
   *  are tick-count-based (LEVEL_SUSTAIN_SAMPLES etc.), not time-based, so those replay
   *  identically regardless of mode or speed. */
  mode?: ReplayMode
  /** paced mode only: 1 = real time, 60 = a 69-minute flight replays in ~69 seconds. */
  speedMultiplier?: number
  /** Hold at the first tick (re-sent every HOLD_INTERVAL_MS, like a parked aircraft) until
   *  release() is called, instead of playing from start(). For an e2e test that starts
   *  tracking itself: the replay otherwise runs from app launch, and free-flight.spec.ts's
   *  fixture takes off 0.8 s in at 200x, so whether tracking started before takeoff (and
   *  the flight got an off time) depended on how fast the CI runner was (runs #166, #171). */
  holdUntilReleased?: boolean
}

const HOLD_INTERVAL_MS = 250

/**
 * Replays a captured flight fixture (scripts/spike-capture-flight.ts's NDJSON output)
 * through the same public surface as SimConnectService (extends EventEmitter,
 * start()/stop()/getStatus()/getLastTelemetry(), the same telemetry/status/paused events)
 * so TrackingController can be driven by a recorded flight instead of a live sim — per
 * winglog-backend's docs/plans/flight-replay-harness.md Phase 1. TrackingController's
 * constructor takes SimConnectSource (Phase 3), the structural interface this class
 * satisfies directly — no cast needed to hand an instance to it.
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
  private readonly holdUntilReleased: boolean
  private holdTimer: NodeJS.Timeout | undefined

  /**
   * @param fixture A fixture file's path, or one already parsed (a transformed capture).
   *
   * @param options Instant or paced, the speed, and whether to hold at the first tick.
   */
  constructor(fixture: string | ParsedFlightFixture, options: ReplaySimConnectServiceOptions = {}) {
    super()
    this.mode = options.mode ?? 'instant'
    this.speedMultiplier = options.speedMultiplier ?? 1
    this.holdUntilReleased = options.holdUntilReleased ?? false

    const { header, events } =
      typeof fixture === 'string' ? parseFlightFixture(readFileSync(fixture, 'utf8')) : fixture
    this.header = header
    this.events = events

    // getLastTelemetry() must return the first tick's data immediately on construction —
    // TrackingController.start() depends on this being non-undefined, and per the plan
    // doc's Design §2 a replay double must satisfy that before start() is even called.
    const firstTelemetry = events.find((e) => e.type === 'telemetry')
    if (!firstTelemetry || firstTelemetry.type !== 'telemetry') {
      throw new Error(
        `Fixture ${typeof fixture === 'string' ? fixture : header.scenario} has no telemetry events`
      )
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
    if (!this.holdUntilReleased) {
      this.playFrom(0)
      return
    }
    const first = this.lastTelemetry
    const sendFirst = (): void => {
      this.emit('telemetry', first)
      this.holdTimer = setTimeout(sendFirst, HOLD_INTERVAL_MS)
    }
    this.holdTimer = setTimeout(sendFirst, 0)
  }

  /** Ends a holdUntilReleased hold and plays the fixture from its start. A no-op otherwise,
   *  or when already released. */
  release(): void {
    if (this.holdTimer === undefined || this.stopped) return
    clearTimeout(this.holdTimer)
    this.holdTimer = undefined
    this.playFrom(0)
  }

  stop(): void {
    this.stopped = true
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.status = { state: 'disconnected' }
  }

  /**
   * Plays the recorded event at `index`, then schedules the next one: straight away in instant mode,
   * otherwise after the recorded gap divided by the speed. Emits replayComplete after the last event.
   *
   * @param index The position in the recording to play.
   */
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
      this.emit('offset', event.tOffsetMs)
      if (event.type === 'telemetry') {
        this.lastTelemetry = event.data
        this.emit('telemetry', event.data)
      } else if (event.type === 'paused') {
        this.emit('paused', event.value)
      } else {
        this.emit('captured', event)
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
