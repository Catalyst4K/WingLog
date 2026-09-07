import { EventEmitter } from 'node:events'
import {
  open,
  Protocol,
  SimConnectConstants,
  SimConnectPeriod,
  type SimConnectConnection
} from 'node-simconnect'
import type { SimConnectionStatus, SimTelemetry } from '@shared/ipc'
import { SIM_VARS } from './simvars'

const APP_NAME = 'WingLog'
const DEFINITION_ID = 0
const REQUEST_ID = 0
const PAUSE_EVENT_ID = 1

const INITIAL_RECONNECT_DELAY_MS = 2_000
const MAX_RECONNECT_DELAY_MS = 30_000

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

        for (const [index, spec] of SIM_VARS.entries()) {
          handle.addToDataDefinition(DEFINITION_ID, spec.name, spec.unit, spec.dataType, 0, index)
        }
        handle.requestDataOnSimObject(
          REQUEST_ID,
          DEFINITION_ID,
          SimConnectConstants.OBJECT_ID_USER,
          SimConnectPeriod.SECOND
        )

        handle.on('simObjectData', (recv) => {
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
}
