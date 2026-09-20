import { EventEmitter } from 'node:events'
import {
  open,
  Protocol,
  SimConnectConstants,
  SimConnectDataType,
  SimConnectPeriod,
  type RawBuffer,
  type SimConnectConnection
} from 'node-simconnect'
import type { SimConnectionStatus, SimTelemetry } from '@shared/ipc'
import type { TouchdownSeverity } from './SimConnectSource'
import { SIM_VARS } from './simvars'

const APP_NAME = 'WingLog'
const DEFINITION_ID = 0
const REQUEST_ID = 0
const PAUSE_EVENT_ID = 1

const INITIAL_RECONNECT_DELAY_MS = 2_000
const MAX_RECONNECT_DELAY_MS = 30_000

// Second, high-rate SimConnect stream for touchdown-severity capture (v1.2 Part 1,
// flightdeck-backend's docs/plans/landing-scoring-v2.md Part 3; real spike findings in
// docs/simconnect-notes.md, 2026-09-20). Own definition/request id, entirely independent of
// the primary 1 Hz stream above, which keeps driving FlightRecorder's phase detection
// exactly as today — its sample-count sustain counters would silently break if that stream's
// own rate changed (found by reading the code, not guessed).
const HIGH_RATE_DEFINITION_ID = 1
const HIGH_RATE_REQUEST_ID = 1
// Matches FlightRecorder's own DESCENT_APPROACH_AGL_M (not imported — sim/ has no existing
// dependency on tracking/, and this is a small, stable constant not worth crossing that
// layering for; scripts/spike-landing-rate.ts made the same call).
const HIGH_RATE_TRIGGER_AGL_M = 500
// How long after touchdown to keep the high-rate stream running before switching back off —
// comfortably past the moment the near-contact peak is computed, so the request doesn't
// flip on/off right at the contact instant itself.
const HIGH_RATE_STOP_AFTER_TOUCHDOWN_MS = 5_000
// The near-contact window the production touchdown-severity value is drawn from — the
// shortest of the three windows the spike measured (1/2/5s), chosen because it stays
// closest to the true instantaneous contact severity without pulling in the earlier part of
// the flare's own deceleration (docs/simconnect-notes.md, 2026-09-20's three real landings).
const NEAR_CONTACT_WINDOW_MS = 1_000
// A liftoff must clear this much AGL, not just read onGround:false, before re-arming —
// taxi bumps/turns can flicker onGround briefly enough to look like a departure otherwise
// (real bug found live, docs/simconnect-notes.md, 2026-09-20's third run).
const LIFTOFF_AGL_MARGIN_M = 3

/** Matches node-simconnect's `open` export — injected so tests don't need a live sim. */
export type OpenSimConnect = typeof open

interface SimConnectServiceEvents {
  telemetry: [SimTelemetry]
  status: [SimConnectionStatus]
  /**
   * The sim's own pause state, via SimConnect's "Pause" system event — used by
   * FlightRecorder to freeze phase detection (PLAN.md §7). NOT yet sim-confirmed on
   * MSFS 2024 (needs a live check per CLAUDE.md's spike rule): a DevSupport report
   * (devsupport.flightsimulator.com, "Pause reporting unpaused immediately after
   * clicking Fly") suggests this event can misbehave on 2024. If it turns out
   * unreliable, "Pause_EX1" is the documented alternative — also reportedly flaky
   * (dwData stuck at zero in some cases). Watch docs/simconnect-notes.md.
   */
  paused: [boolean]
  touchdownSeverity: [TouchdownSeverity]
}

/**
 * Connects to MSFS via node-simconnect, streaming telemetry at 1 Hz with auto-reconnect.
 * Sim-confirmed behaviour (SimVar names, unit strings, reconnect timing) lives in
 * docs/simconnect-notes.md — this is the M1 spike (scripts/spike-simconnect.ts) folded
 * into a real service, per PLAN.md §6.
 */
export class SimConnectService extends EventEmitter<SimConnectServiceEvents> {
  private handle: SimConnectConnection | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private stopped = false
  private status: SimConnectionStatus = { state: 'disconnected' }
  private lastTelemetry: SimTelemetry | undefined

  // High-rate touchdown-severity tracking (see the constants block above for the design
  // this implements). All reset at the top of a fresh connect() — meaningless carried over
  // from a dropped connection's now-closed handle.
  private highRateActive = false
  // Starts true so the very first landing of a session is captured too — a genuine liftoff
  // isn't required before the *first* arming, only between one captured touchdown and the
  // next (see the re-arm check in evaluateHighRateArming).
  private awaitingLanding = true
  // undefined (not false) until the first baseline tick — mirrors TrackingController's own
  // wasOnGround, so the very first tick of a session already on the ground can never itself
  // read as a liftoff/touchdown edge.
  private wasOnGroundBaseline: boolean | undefined
  private wasOnGroundHighRate = false
  private touchdownAt: number | null = null
  private ringBuffer: { t: number; verticalSpeedMs: number }[] = []

  constructor(private readonly openSimConnect: OpenSimConnect = open) {
    super()
  }

  /**
   * Current status, for a renderer that mounts after the initial connect already
   * happened — `status` events are fire-and-forget over IPC and aren't replayed to late
   * subscribers, so a freshly-mounted renderer needs to pull this once on mount.
   */
  getStatus(): SimConnectionStatus {
    return this.status
  }

  /** Most recent telemetry sample, for snapshotting state (e.g. fuel) outside the 1 Hz stream. */
  getLastTelemetry(): SimTelemetry | undefined {
    return this.lastTelemetry
  }

  private setStatus(status: SimConnectionStatus): void {
    this.status = status
    this.emit('status', status)
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.handle?.close()
    this.handle = undefined
  }

  private connect(reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS): void {
    if (this.stopped) return
    this.setStatus({ state: 'connecting' })

    this.openSimConnect(APP_NAME, Protocol.SunRise)
      .then(({ recvOpen, handle }) => {
        if (this.stopped) {
          handle.close()
          return
        }
        this.handle = handle
        this.setStatus({
          state: 'connected',
          simConnectVersion: `${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor}`
        })

        // Meaningless carried over from a previous, now-closed handle — a fresh connection
        // starts this tracking from scratch.
        this.highRateActive = false
        this.awaitingLanding = true
        this.wasOnGroundBaseline = undefined
        this.wasOnGroundHighRate = false
        this.touchdownAt = null
        this.ringBuffer = []

        for (const [index, spec] of SIM_VARS.entries()) {
          handle.addToDataDefinition(DEFINITION_ID, spec.name, spec.unit, spec.dataType, 0, index)
        }
        handle.requestDataOnSimObject(
          REQUEST_ID,
          DEFINITION_ID,
          SimConnectConstants.OBJECT_ID_USER,
          SimConnectPeriod.SECOND
        )

        // High-rate definition — only what the near-contact peak needs (see the constants
        // block's own doc comment). Not requested yet; armed/disarmed by
        // evaluateHighRateArming below as the primary stream's own telemetry crosses the
        // trigger altitude.
        handle.addToDataDefinition(HIGH_RATE_DEFINITION_ID, 'VERTICAL SPEED', 'meters per second', SimConnectDataType.FLOAT64, 0, 0)
        handle.addToDataDefinition(HIGH_RATE_DEFINITION_ID, 'SIM ON GROUND', 'bool', SimConnectDataType.INT32, 0, 1)

        handle.on('simObjectData', (recv) => {
          if (recv.requestID === HIGH_RATE_REQUEST_ID) {
            this.handleHighRateTick(recv.data)
            return
          }
          if (recv.requestID !== REQUEST_ID) return
          const fields: Record<string, unknown> = {}
          for (const spec of SIM_VARS) {
            fields[spec.key] = spec.read(recv.data)
          }
          // SIM_VARS is a heterogeneous const array; per-field typing is enforced at its
          // declaration site, so a single cast here (rather than one per field) is fine.
          const telemetry = fields as unknown as SimTelemetry
          this.lastTelemetry = telemetry
          this.emit('telemetry', telemetry)
          this.evaluateHighRateArming(telemetry)
        })

        handle.subscribeToSystemEvent(PAUSE_EVENT_ID, 'Pause')
        handle.on('event', (recvEvent) => {
          if (recvEvent.clientEventId !== PAUSE_EVENT_ID) return
          this.emit('paused', recvEvent.data === 1)
        })

        handle.on('quit', () => this.handleDisconnect())
        handle.on('close', () => this.handleDisconnect())
      })
      .catch(() => {
        this.scheduleReconnect(reconnectDelayMs)
      })
  }

  private handleDisconnect(): void {
    if (this.stopped) return
    this.handle = undefined
    this.scheduleReconnect()
  }

  private scheduleReconnect(delayMs = INITIAL_RECONNECT_DELAY_MS): void {
    if (this.stopped) return
    this.setStatus({ state: 'disconnected' })
    this.reconnectTimer = setTimeout(
      () => this.connect(Math.min(delayMs * 2, MAX_RECONNECT_DELAY_MS)),
      delayMs
    )
  }

  /**
   * Arms/re-arms the high-rate stream from the primary 1 Hz telemetry alone — called on
   * every baseline tick. Requires genuinely airborne (`!onGround`), not just the altitude
   * band, before arming: AGL alone is also true during the takeoff roll/initial climb, and
   * arming while still on the ground reset wasOnGroundHighRate against a same-tick onGround
   * still true, tripping a false touchdown with an empty ring buffer (real bug found live,
   * docs/simconnect-notes.md, 2026-09-20's third run — scripts/spike-landing-rate.ts hit
   * this first and is fixed the same way).
   */
  private evaluateHighRateArming(telemetry: SimTelemetry): void {
    if (
      !this.highRateActive &&
      this.awaitingLanding &&
      !telemetry.onGround &&
      telemetry.altitudeAglM < HIGH_RATE_TRIGGER_AGL_M &&
      telemetry.altitudeAglM > 0
    ) {
      this.startHighRate()
    }
    // A genuine liftoff (real altitude margin, not just the boolean — see
    // LIFTOFF_AGL_MARGIN_M's own doc comment) re-arms detection for the next approach.
    if (
      this.wasOnGroundBaseline === true &&
      !telemetry.onGround &&
      telemetry.altitudeAglM > LIFTOFF_AGL_MARGIN_M
    ) {
      this.awaitingLanding = true
    }
    this.wasOnGroundBaseline = telemetry.onGround
  }

  private startHighRate(): void {
    if (!this.handle || this.highRateActive) return
    this.highRateActive = true
    this.ringBuffer = []
    this.wasOnGroundHighRate = false
    this.touchdownAt = null
    this.handle.requestDataOnSimObject(
      HIGH_RATE_REQUEST_ID,
      HIGH_RATE_DEFINITION_ID,
      SimConnectConstants.OBJECT_ID_USER,
      SimConnectPeriod.SIM_FRAME
    )
  }

  private stopHighRate(): void {
    if (!this.handle || !this.highRateActive) return
    this.highRateActive = false
    this.handle.requestDataOnSimObject(
      HIGH_RATE_REQUEST_ID,
      HIGH_RATE_DEFINITION_ID,
      SimConnectConstants.OBJECT_ID_USER,
      SimConnectPeriod.NEVER
    )
  }

  private handleHighRateTick(data: RawBuffer): void {
    const verticalSpeedMs = data.readFloat64()
    const onGround = data.readInt32() === 1
    const now = Date.now()

    this.ringBuffer.push({ t: now, verticalSpeedMs })
    while (this.ringBuffer.length > 0 && this.ringBuffer[0]!.t < now - NEAR_CONTACT_WINDOW_MS) {
      this.ringBuffer.shift()
    }

    // The precise moment, to the tick, this stream itself saw ground contact — independent
    // of the primary stream's own coarser 1 Hz detection, which TrackingController still
    // drives its own touchdown row from (this only supplies a better verticalSpeedMs for it).
    if (!this.wasOnGroundHighRate && onGround && this.touchdownAt === null) {
      this.touchdownAt = now
      const peak = this.ringBuffer.reduce<{ t: number; verticalSpeedMs: number } | null>(
        (best, p) => (best === null || Math.abs(p.verticalSpeedMs) > Math.abs(best.verticalSpeedMs) ? p : best),
        null
      )
      if (peak) this.emit('touchdownSeverity', { verticalSpeedMs: peak.verticalSpeedMs })
    }
    this.wasOnGroundHighRate = onGround

    // highRateActive guard: a couple of ticks can still arrive after requestDataOnSimObject
    // NEVER takes effect (found live, docs/simconnect-notes.md, 2026-09-20) — without it
    // this would call stopHighRate/emit repeatedly for every leftover tick.
    if (this.highRateActive && this.touchdownAt !== null && now - this.touchdownAt >= HIGH_RATE_STOP_AFTER_TOUCHDOWN_MS) {
      this.stopHighRate()
      this.awaitingLanding = false // captured; don't re-arm until a real liftoff happens
    }
  }
}
